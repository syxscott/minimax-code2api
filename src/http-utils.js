// Shared HTTP helpers: body reading, dual-protocol error responses, key auth.

export const MAX_BODY_BYTES = 64 * 1024 * 1024; // matches upstream max_request_body_bytes

export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res, status, obj, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

// One JSON shape that both the Anthropic SDK ({type:'error',error:{...}}) and
// the OpenAI SDK ({error:{...}}) accept.
export function sendProtocolError(res, status, type, message, code = null) {
  sendJson(res, status, {
    type: 'error',
    error: { type, message, code },
  });
}

export function sendSseError(res, status, type, message) {
  if (res.headersSent) {
    res.write(
      `event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: { type, message },
      })}\n\n`,
    );
    res.end();
    return;
  }
  sendProtocolError(res, status, type, message);
}

export function isAuthorized(req, config) {
  if (!config.apiKeys || config.apiKeys.length === 0) return true;
  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const xApiKey = String(req.headers['x-api-key'] ?? '').trim();
  const queryKey = new URL(req.url ?? '/', 'http://localhost').searchParams.get('key') ?? '';
  return (
    (bearer && config.apiKeys.includes(bearer)) ||
    (xApiKey && config.apiKeys.includes(xApiKey)) ||
    (queryKey && config.apiKeys.includes(queryKey))
  );
}

export function clientAborted(req) {
  return req.destroyed || req.errored;
}
