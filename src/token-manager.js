// Caches leased tokens and serializes lease requests (single-flight).
// The desktop broker owns refresh — we only ask for a token that is valid
// for at least AUTH_LEASE_MAX_MIN_VALIDITY_MS, keep it while it stays fresh
// (>= REFRESH_MARGIN_MS left), and drop it on upstream 401.
import {
  AUTH_LEASE_MAX_MIN_VALIDITY_MS,
  AuthLeaseError,
  requestLease,
  requestStatus,
} from './lease.js';

const REFRESH_MARGIN_MS = 60 * 1000;
const STATUS_CACHE_MS = 3000;

export class TokenManager {
  constructor(dataDir, log) {
    this.dataDir = dataDir;
    this.log = log;
    this.cached = null; // { accessToken, expiresAtMs, generation }
    this.inflight = null; // Promise<token>
    this.statusCache = { value: null, at: 0 };
  }

  async getToken() {
    const now = Date.now();
    if (this.cached && this.cached.expiresAtMs - now > REFRESH_MARGIN_MS) {
      return this.cached;
    }
    if (!this.inflight) {
      this.inflight = requestLease(this.dataDir, AUTH_LEASE_MAX_MIN_VALIDITY_MS)
        .then((token) => {
          this.cached = token;
          this.log.info(
            `leased access token (generation ${token.generation}, expires in ${Math.max(0, Math.round((token.expiresAtMs - Date.now()) / 1000))}s)`,
          );
          return token;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  invalidate(reason) {
    if (this.cached) {
      this.log.info(`invalidating leased token: ${reason}`);
      this.cached = null;
    }
  }

  async getStatus(force = false) {
    const now = Date.now();
    if (!force && this.statusCache.value && now - this.statusCache.at < STATUS_CACHE_MS) {
      return this.statusCache.value;
    }
    const value = await requestStatus(this.dataDir);
    this.statusCache = { value, at: now };
    return value;
  }
}

export { AuthLeaseError };
