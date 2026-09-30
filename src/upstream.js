// Forwards requests to the managed MiniMax endpoint, authenticated with a
// leased token. Reproduces the header set the official desktop client sends
// for managed-login (see MiniMax-AI/minimax-code
// packages/local-runtime/src/runtime/model-resolver-helpers.ts):
//   Authorization: Bearer <token>
//   User-Agent: MiniMaxAgent
//   X-Mavis-Session-Id / X-Mavis-Agent-Id / X-Mavis-Timezone-Offset
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { anthropicMessagesUrl, filesUploadUrl } from './config.js';

const SESSION_ID = crypto.randomUUID();
const AGENT_ID = 'main';
const TIMEZONE_OFFSET_SECONDS = new Date().getTimezoneOffset() * -60;

const UPSTREAM_KEEPALIVE = new https.Agent({
  keepAlive: true,
  maxSockets: 16,
});

export function managedAuthHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'MiniMaxAgent',
    'X-Mavis-Session-Id': SESSION_ID,
    'X-Mavis-Agent-Id': AGENT_ID,
    'X-Mavis-Timezone-Offset': String(TIMEZONE_OFFSET_SECONDS),
  };
}

export class UpstreamError extends Error {
  constructor(status, body, contentType) {
    super(`Upstream responded ${status}`);
    this.status = status;
    this.body = body; // Buffer
    this.contentType = contentType ?? 'application/json';
  }
}

/**
 * Perform one upstream HTTP call. Returns the upstream http.IncomingMessage
 * (already headed — caller pipes or buffers it). Throws UpstreamError for
 * non-2xx responses when `stream` is false; when `stream` is true the
 * response object is returned regardless of status so the caller can relay
 * the error body/SSE itself.
 */
export function upstreamRequest({ config, tokenManager, url, method = 'POST', headers = {}, body, stream = false, signal }) {
  return new Promise((resolve, reject) => {
    tokenManager
      .getToken()
      .then((token) => {
        const target = new URL(url);
        const isFilesUpload = target.pathname.endsWith('/files/upload');
        const isTls = target.protocol === 'https:';
        const transport = isTls ? https : http;
        const requestHeaders = {
          ...managedAuthHeaders(token.accessToken),
          Accept: 'application/json',
          ...headers,
        };
        if (!isFilesUpload && !requestHeaders['Content-Type'] && body) {
          requestHeaders['Content-Type'] = 'application/json';
        }

        const req = transport.request(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (isTls ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method,
            headers: requestHeaders,
            agent: isTls ? UPSTREAM_KEEPALIVE : undefined,
          },
          (res) => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(res);
              return;
            }
            if (stream) {
              resolve(res);
              return;
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const buf = Buffer.concat(chunks);
              if (res.statusCode === 401) tokenManager.invalidate('upstream 401');
              reject(new UpstreamError(res.statusCode, buf, res.headers['content-type']));
            });
            res.on('error', (error) => reject(error));
          },
        );
        req.on('error', (error) => {
          if (signal?.aborted) return;
          reject(error);
        });
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              req.destroy(new Error('client aborted'));
            },
            { once: true },
          );
        }
        if (body) req.write(body);
        req.end();
      })
      .catch(reject);
  });
}

/**
 * Run `attempt` against upstream; on 401 invalidate the leased token, take a
 * fresh lease and retry exactly once. `attempt` receives no arguments and
 * should throw UpstreamError(status===401) for auth failures.
 */
export async function withTokenRetry(attempt) {
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 401) {
      return attempt();
    }
    throw error;
  }
}

export { anthropicMessagesUrl, filesUploadUrl };
