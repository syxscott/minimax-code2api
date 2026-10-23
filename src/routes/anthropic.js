// Anthropic-protocol routes. /v1/messages is a near-raw passthrough: the
// upstream managed endpoint natively speaks Anthropic Messages, so we only
// rewrite the model id, inject auth, and relay bytes both ways.
import { anthropicMessagesUrl, filesUploadUrl } from '../config.js';
import { resolveUpstreamModel, MINIMAX_MODELS } from '../models.js';
import { UpstreamError, upstreamRequest, withTokenRetry, acquireSessionId } from '../upstream.js';
import { readBody, sendJson, sendProtocolError } from '../http-utils.js';

// Approximate the desktop client's one-X-Mavis-Session-Id-per-conversation
// behavior: prefer an explicit client session marker, fall back to a stable
// id per client IP that rotates after idle.
function sessionHintFor(headers, body) {
  return (
    String(headers['x-session-id'] ?? '').trim() ||
    (typeof body?.metadata?.user_id === 'string' && body.metadata.user_id.trim()) ||
    ''
  );
}

function clientKeyFor(req) {
  return req.socket?.remoteAddress ?? 'local';
}

export async function handleMessages(req, res, ctx) {
  const { config, tokenManager, log, stats } = ctx;
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (error) {
    sendProtocolError(res, error?.statusCode ?? 400, 'invalid_request_error', `invalid JSON body: ${error.message}`);
    return;
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    sendProtocolError(res, 400, 'invalid_request_error', 'messages[] is required');
    return;
  }

  const { model: upstreamModel, mappedFrom } = resolveUpstreamModel(body.model, config);
  if (mappedFrom) log.info(`anthropic: mapped model "${mappedFrom}" -> "${upstreamModel}"`);
  body.model = upstreamModel;
  if (!Number.isFinite(body.max_tokens) || body.max_tokens <= 0) body.max_tokens = 16384;

  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const streaming = body.stream === true;
  const sessionId = acquireSessionId(sessionHintFor(req.headers, body), clientKeyFor(req));
  // Relay Anthropic-protocol client headers the upstream may act on.
  const clientHeaders = {};
  if (req.headers['anthropic-beta']) clientHeaders['anthropic-beta'] = req.headers['anthropic-beta'];
  if (req.headers.accept) clientHeaders.Accept = req.headers.accept;
  stats.anthropic.requests += 1;

  const attempt = () =>
    upstreamRequest({
      config,
      tokenManager,
      url: anthropicMessagesUrl(config),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...clientHeaders },
      body: payload,
      stream: true,
      signal: req.abortSignal,
      sessionId,
    }).then(async (upRes) => {
      if (upRes.statusCode !== 200) {
        const chunks = [];
        for await (const c of upRes) chunks.push(c);
        const buf = Buffer.concat(chunks);
        if (upRes.statusCode === 401) tokenManager.invalidate('upstream 401');
        throw new UpstreamError(upRes.statusCode, buf, upRes.headers['content-type']);
      }
      return upRes;
    });

  try {
    const upRes = await withTokenRetry(attempt);
    const headers = {
      'Content-Type': upRes.headers['content-type'] ?? (streaming ? 'text/event-stream' : 'application/json'),
    };
    if (upRes.headers['request-id']) headers['request-id'] = upRes.headers['request-id'];
    if (streaming) {
      res.writeHead(200, headers);
      upRes.pipe(res);
      upRes.on('end', () => {
        if (!res.writableEnded) res.end();
      });
      req.on('close', () => {
        if (!upRes.complete) upRes.destroy();
      });
    } else {
      const chunks = [];
      for await (const c of upRes) chunks.push(c);
      const buf = Buffer.concat(chunks);
      res.writeHead(200, headers);
      res.end(buf);
    }
  } catch (error) {
    stats.anthropic.errors += 1;
    respondUpstreamError(res, error, log);
  }
}

export async function handleCountTokens(req, res, ctx) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    body = {};
  }
  const serialized = JSON.stringify(body.messages ?? []);
  const estimate = Math.ceil(serialized.length / 4) + Math.ceil(JSON.stringify(body.system ?? '').length / 4);
  sendJson(res, 200, { input_tokens: estimate });
}

export async function handleFilesUpload(req, res, ctx) {
  const { config, tokenManager, log, stats } = ctx;
  stats.anthropic.requests += 1;
  const payload = await readBody(req);
  const attempt = () =>
    upstreamRequest({
      config,
      tokenManager,
      url: filesUploadUrl(config),
      method: 'POST',
      headers: {
        'Content-Type': req.headers['content-type'] ?? 'application/octet-stream',
      },
      body: payload,
      signal: req.abortSignal,
    }).then(async (upRes) => {
      if (upRes.statusCode !== 200) {
        const chunks = [];
        for await (const c of upRes) chunks.push(c);
        const buf = Buffer.concat(chunks);
        if (upRes.statusCode === 401) tokenManager.invalidate('upstream 401');
        throw new UpstreamError(upRes.statusCode, buf, upRes.headers['content-type']);
      }
      return upRes;
    });
  try {
    const upRes = await withTokenRetry(attempt);
    const chunks = [];
    for await (const c of upRes) chunks.push(c);
    res.writeHead(200, { 'Content-Type': upRes.headers['content-type'] ?? 'application/json' });
    res.end(Buffer.concat(chunks));
  } catch (error) {
    stats.anthropic.errors += 1;
    respondUpstreamError(res, error, log);
  }
}

// Shared by both protocol routes.
export function respondUpstreamError(res, error, log) {
  if (error instanceof UpstreamError) {
    const contentType = error.contentType ?? 'application/json';
    if (contentType.includes('application/json')) {
      let parsed = null;
      try {
        parsed = JSON.parse(error.body.toString('utf8'));
      } catch {
        parsed = null;
      }
      if (parsed) {
        sendJson(res, error.status, parsed);
        return;
      }
    }
    res.writeHead(error.status, { 'Content-Type': contentType || 'text/plain' });
    res.end(error.body);
    return;
  }
  if (error?.message === 'client aborted' || res.req?.destroyed) {
    try {
      res.destroy();
    } catch {}
    return;
  }
  log.error('upstream request failed:', error);
  sendProtocolError(res, 502, 'api_error', `upstream request failed: ${error.message}`);
}

export function modelsPayload() {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: Object.values(MINIMAX_MODELS).map((m) => ({
      id: m.id,
      object: 'model',
      type: 'model',
      created: now,
      owned_by: 'minimax',
      display_name: m.display_name,
      context_window: m.context,
      max_output_tokens: m.max_output,
    })),
  };
}
