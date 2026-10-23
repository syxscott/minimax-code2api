// OpenAI Responses API route — the wire protocol Codex CLI requires.
// Chain: Responses -> Chat (responses-to-chat) -> Anthropic (existing
// converter) upstream-side, and the reverse on the way back.
import { anthropicMessagesUrl } from '../config.js';
import { resolveUpstreamModel, MINIMAX_MODELS } from '../models.js';
import { responsesToChat } from '../convert/responses-to-chat.js';
import { convertOpenAiToAnthropic } from '../convert/openai-to-anthropic.js';
import {
  convertNonStreamResponse,
  createResponsesStreamTransformer,
} from '../convert/chat-to-responses.js';
import { UpstreamError, upstreamRequest, withTokenRetry, acquireSessionId } from '../upstream.js';
import { readBody, sendJson, sendProtocolError } from '../http-utils.js';
import { respondUpstreamError } from './anthropic.js';

export async function handleResponses(req, res, ctx) {
  const { config, tokenManager, log, stats } = ctx;
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (error) {
    sendProtocolError(res, error?.statusCode ?? 400, 'invalid_request_error', `invalid JSON body: ${error.message}`);
    return;
  }
  if (!body || typeof body !== 'object') {
    sendProtocolError(res, 400, 'invalid_request_error', 'request body required');
    return;
  }
  if (body.previous_response_id) {
    // Stateless gateway: clients must replay conversation input (Codex with
    // store:false already does).
    sendProtocolError(res, 400, 'invalid_request_error',
      'previous_response_id is not supported (stateless proxy); send full input[] each turn');
    return;
  }

  const { model: upstreamModel, mappedFrom } = resolveUpstreamModel(body.model, config);
  if (mappedFrom) log.info(`responses: mapped model "${mappedFrom}" -> "${upstreamModel}"`);
  const clientModelName = mappedFrom || body.model || upstreamModel;
  const modelMeta = MINIMAX_MODELS[upstreamModel];

  const chat = responsesToChat(body);
  const customToolNames = chat.__customToolNames ?? new Set();
  delete chat.__customToolNames;
  const converted = convertOpenAiToAnthropic(chat, upstreamModel, modelMeta);
  if (!converted.max_tokens) converted.max_tokens = 16384;

  const streaming = body.stream === true;
  stats.openai.requests += 1;
  const sessionId = acquireSessionId(
    String(req.headers['x-session-id'] ?? '').trim() || (typeof body.user === 'string' && body.user.trim()) || '',
    req.socket?.remoteAddress ?? 'local',
  );

  const payload = Buffer.from(JSON.stringify(converted), 'utf8');
  const attempt = () =>
    upstreamRequest({
      config,
      tokenManager,
      url: anthropicMessagesUrl(config),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
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
    if (streaming) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const transformer = createResponsesStreamTransformer({
        model: clientModelName,
        created: Math.floor(Date.now() / 1000),
        customToolNames,
        log,
      });
      upRes.on('data', (chunk) => {
        const out = transformer.push(chunk);
        if (out.length > 0) res.write(out);
      });
      upRes.on('end', () => {
        const tail = transformer.end();
        if (tail.length > 0) res.write(tail);
        res.end();
      });
      upRes.on('error', (error) => {
        log.error('upstream stream error:', error.message);
        res.end();
      });
      req.on('close', () => {
        if (!upRes.complete) upRes.destroy();
      });
    } else {
      const chunks = [];
      for await (const c of upRes) chunks.push(c);
      const anthropicBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      sendJson(res, 200, convertNonStreamResponse(anthropicBody, clientModelName, customToolNames));
    }
  } catch (error) {
    stats.openai.errors += 1;
    respondUpstreamError(res, error, log);
  }
}
