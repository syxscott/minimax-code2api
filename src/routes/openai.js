// OpenAI-protocol routes. /v1/chat/completions converts OpenAI Chat
// Completions to Anthropic Messages upstream-side and converts responses /
// SSE streams back, so any OpenAI-protocol client works unchanged.
import crypto from 'node:crypto';
import { anthropicMessagesUrl } from '../config.js';
import { resolveUpstreamModel, MINIMAX_MODELS } from '../models.js';
import { convertOpenAiToAnthropic } from '../convert/openai-to-anthropic.js';
import {
  convertNonStreamResponse,
  createStreamTransformer,
} from '../convert/anthropic-to-openai.js';
import { UpstreamError, upstreamRequest, withTokenRetry } from '../upstream.js';
import { readBody, sendJson, sendProtocolError, sendSseError } from '../http-utils.js';
import { respondUpstreamError, modelsPayload } from './anthropic.js';

export async function handleChatCompletions(req, res, ctx) {
  const { config, tokenManager, log, stats } = ctx;
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (error) {
    sendProtocolError(res, error?.statusCode ?? 400, 'invalid_request_error', `invalid JSON body: ${error.message}`);
    return;
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) {
    sendProtocolError(res, 400, 'invalid_request_error', 'messages[] is required');
    return;
  }

  const { model: upstreamModel, mappedFrom } = resolveUpstreamModel(body.model, config);
  if (mappedFrom) log.info(`openai: mapped model "${mappedFrom}" -> "${upstreamModel}"`);
  const openaiModelName = mappedFrom || body.model || upstreamModel;
  const modelMeta = MINIMAX_MODELS[upstreamModel];

  const converted = convertOpenAiToAnthropic(body, upstreamModel, modelMeta);
  const streaming = converted.stream === true;
  const openaiId = `chatcmpl-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  stats.openai.requests += 1;

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
      const transformer = createStreamTransformer({ id: openaiId, model: openaiModelName, created, log });
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
        sendSseError(res, null, 'api_error', 'upstream stream error');
      });
      req.on('close', () => {
        if (!upRes.complete) upRes.destroy();
      });
    } else {
      const chunks = [];
      for await (const c of upRes) chunks.push(c);
      const anthropicBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const openaiResponse = convertNonStreamResponse(anthropicBody, openaiModelName);
      sendJson(res, 200, openaiResponse);
    }
  } catch (error) {
    stats.openai.errors += 1;
    if (streaming) {
      sendSseError(res, error instanceof UpstreamError ? error.status : 502, 'api_error', describeUpstreamError(error));
      return;
    }
    respondUpstreamError(res, error, log);
  }
}

export function handleOpenAiModels(req, res) {
  sendJson(res, 200, modelsPayload());
}

function describeUpstreamError(error) {
  if (error instanceof UpstreamError) {
    try {
      const parsed = JSON.parse(error.body.toString('utf8'));
      return parsed?.error?.message ?? `upstream ${error.status}`;
    } catch {
      return `upstream ${error.status}`;
    }
  }
  return `upstream request failed: ${error.message}`;
}
