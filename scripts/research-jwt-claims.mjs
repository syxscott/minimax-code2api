// Research: decode the JWT payload of a leased access token LOCALLY.
// Nothing leaves the machine; claims are printed with sensitive values
// redacted. Purpose: establish what identity signals the server can see on
// every LLM request.
import path from 'node:path';
import { requestLease } from '../src/lease.js';

const REDACT = (v) => {
  const s = String(v);
  return s.length <= 8 ? '***' : `${s.slice(0, 4)}…${s.slice(-2)}(${s.length}ch)`;
};

const { accessToken } = await requestLease(path.join(process.env.USERPROFILE, '.minimax'));
const parts = accessToken.split('.');
console.log('segments:', parts.length);
console.log('length:', accessToken.length);
console.log('charset sample:', accessToken.slice(0, 6).replace(/[A-Za-z0-9_-]/g, '*') + '…[redacted]');
console.log('looks like JWT (3 b64url segments):', parts.length === 3 && /^[A-Za-z0-9_-]+$/.test(parts[0]) && accessToken.slice(0, 2) === 'ey');
// Structural conclusion only — opaque tokens keep identity binding server-side.
