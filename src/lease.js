// Auth-lease client for the MiniMax Code desktop broker.
//
// Adapted from MiniMax-AI/minimax-code, packages/oauth-lease-protocol
// (src/contracts.ts, src/codec.ts, src/endpoints.ts), Copyright (c) 2026
// MiniMax Code, MIT License. Ported to plain JavaScript and trimmed to the
// client-side subset. See NOTICE.
//
// Wire protocol: each request/response is a JSON payload prefixed with a
// 4-byte big-endian length, carried over a local named pipe (Windows) or a
// unix domain socket. The broker is the running desktop app; it owns token
// refresh. This process never reads or writes credential files.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const AUTH_LEASE_PROTOCOL_VERSION = 1;
export const AUTH_LEASE_MAX_FRAME_BYTES = 64 * 1024;
export const AUTH_LEASE_MAX_MIN_VALIDITY_MS = 5 * 60 * 1000;

const SOCKET_FILE = 'mcode-auth-lease-v1.sock';
const CAPABILITY_FILE = 'mcode-auth-lease-v1.cap';
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\mcode-auth-lease-';

const ERROR_MESSAGES = Object.freeze({
  AUTH_REQUIRED: 'Desktop authentication is required.',
  BROKER_UNAVAILABLE: 'Desktop authentication integration is unavailable.',
  CAPABILITY_REJECTED: 'Desktop authentication capability was rejected.',
  PROTOCOL_MISMATCH: 'Desktop authentication protocol is incompatible.',
  INVALID_REQUEST: 'Desktop authentication request is invalid.',
  INTERNAL_ERROR: 'Desktop authentication request failed.',
});

export class AuthLeaseError extends Error {
  constructor(code, message, cause) {
    super(message ?? ERROR_MESSAGES[code] ?? 'auth lease failed');
    this.name = 'AuthLeaseError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export function resolveLeaseEndpoint(dataDir, platform = process.platform) {
  if (platform === 'win32') {
    // The broker names its pipe after the lowercased, win32-NORMALIZED data
    // dir (backslashes). Forward-slash joins hash to a different pipe —
    // normalize first, exactly like the official client does.
    if (!path.win32.isAbsolute(dataDir)) {
      throw new AuthLeaseError('INVALID_REQUEST', 'dataDir must be an absolute path on Windows.');
    }
    const canonical = path.win32.normalize(dataDir).replace(/[\\/]+$/u, '');
    const digest = crypto
      .createHash('sha256')
      .update(canonical.toLowerCase())
      .digest('hex')
      .slice(0, 16);
    return {
      transport: 'pipe',
      endpoint: `${WINDOWS_PIPE_PREFIX}${digest}`,
      capabilityFile: path.win32.join(canonical, 'run', CAPABILITY_FILE),
    };
  }
  if (!path.isAbsolute(dataDir)) {
    throw new AuthLeaseError('INVALID_REQUEST', 'dataDir must be an absolute path.');
  }
  const canonical = path.normalize(dataDir).replace(/[\\/]+$/u, '');
  return {
    transport: 'unix',
    endpoint: path.join(canonical, 'run', SOCKET_FILE),
    capabilityFile: path.join(canonical, 'run', CAPABILITY_FILE),
  };
}

export function readCapability(dataDir) {
  const { capabilityFile } = resolveLeaseEndpoint(dataDir);
  let cap;
  try {
    cap = fs.readFileSync(capabilityFile, 'utf8').trim();
  } catch (error) {
    throw new AuthLeaseError(
      'BROKER_UNAVAILABLE',
      `Cannot read capability file ${capabilityFile}. ` +
        `Is the MiniMax Code desktop app installed and logged in on this machine? (${error?.code ?? error?.message})`,
    );
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(cap)) {
    throw new AuthLeaseError('BROKER_UNAVAILABLE', 'Capability file has unexpected content.');
  }
  return cap;
}

export function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length === 0 || payload.length > AUTH_LEASE_MAX_FRAME_BYTES) {
    throw new AuthLeaseError('INVALID_REQUEST', 'Frame payload out of bounds.');
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames = [];
    while (this.buffer.length >= 4) {
      const payloadLength = this.buffer.readUInt32BE(0);
      if (payloadLength === 0 || payloadLength > AUTH_LEASE_MAX_FRAME_BYTES) {
        throw new AuthLeaseError('PROTOCOL_MISMATCH', 'Broker sent an invalid frame length.');
      }
      const frameLength = 4 + payloadLength;
      if (this.buffer.length < frameLength) return frames;
      const payload = this.buffer.subarray(4, frameLength);
      this.buffer = this.buffer.subarray(frameLength);
      try {
        frames.push(JSON.parse(payload.toString('utf8')));
      } catch {
        throw new AuthLeaseError('PROTOCOL_MISMATCH', 'Broker sent a non-JSON frame.');
      }
    }
    return frames;
  }
}

function assertOk(response) {
  if (response && response.ok === true) return response;
  const code =
    response && response.ok === false && response.error && ERROR_MESSAGES[response.error.code]
      ? response.error.code
      : 'INTERNAL_ERROR';
  throw new AuthLeaseError(code);
}

function sendRequest(endpoint, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint.endpoint);
    const decoder = new FrameDecoder();
    let settled = false;

    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      settle(
        new AuthLeaseError('BROKER_UNAVAILABLE', `Broker did not respond within ${timeoutMs}ms.`),
      );
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(encodeFrame(request));
    });
    socket.on('data', (chunk) => {
      try {
        const frames = decoder.push(chunk);
        if (frames.length > 0) settle(undefined, frames[0]);
      } catch (error) {
        settle(error);
      }
    });
    socket.on('error', (error) => {
      settle(
        new AuthLeaseError(
          'BROKER_UNAVAILABLE',
          `Cannot reach auth broker at ${endpoint.endpoint}: ${error.message}. ` +
            'Is the MiniMax Code desktop app running?',
        ),
      );
    });
    socket.on('close', () => {
      settle(new AuthLeaseError('BROKER_UNAVAILABLE', 'Broker closed the connection early.'));
    });
  });
}

export async function requestStatus(dataDir, timeoutMs = 5000) {
  const endpoint = resolveLeaseEndpoint(dataDir);
  const capability = readCapability(dataDir);
  const response = await sendRequest(
    endpoint,
    {
      version: AUTH_LEASE_PROTOCOL_VERSION,
      requestId: `m2a-status-${Date.now().toString(36)}`,
      capability,
      method: 'status',
    },
    timeoutMs,
  );
  const result = assertOk(response).result;
  return { status: result.status, generation: result.generation, expiresAtMs: result.expiresAtMs };
}

export async function requestLease(dataDir, minValidityMs = AUTH_LEASE_MAX_MIN_VALIDITY_MS, timeoutMs = 10000) {
  const endpoint = resolveLeaseEndpoint(dataDir);
  const capability = readCapability(dataDir);
  const clamped = Math.max(0, Math.min(Math.floor(minValidityMs), AUTH_LEASE_MAX_MIN_VALIDITY_MS));
  const response = await sendRequest(
    endpoint,
    {
      version: AUTH_LEASE_PROTOCOL_VERSION,
      requestId: `m2a-lease-${Date.now().toString(36)}`,
      capability,
      method: 'lease',
      minValidityMs: clamped,
    },
    timeoutMs,
  );
  const result = assertOk(response).result;
  return {
    accessToken: result.accessToken,
    expiresAtMs: result.expiresAtMs,
    generation: result.generation,
  };
}
