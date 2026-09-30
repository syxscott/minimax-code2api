// Anthropic Messages response / SSE stream -> OpenAI Chat Completions.
// Non-stream: convert a full JSON response body.
// Stream: incremental SSE re-writer. Anthropic emits typed events
// (message_start, content_block_*, message_delta, message_stop); we emit
// OpenAI chat.completion.chunk frames and a final [DONE].

const CHUNK_STOP_REASON = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

export function makeChunkBase(id, model, created) {
  return { id, object: 'chat.completion.chunk', created, model };
}

export function convertNonStreamResponse(anthropicBody, openaiModelName) {
  const contentParts = [];
  const reasoningParts = [];
  const toolCalls = [];
  for (const block of anthropicBody.content ?? []) {
    if (block?.type === 'text') contentParts.push(block.text ?? '');
    else if (block?.type === 'thinking') reasoningParts.push(block.thinking ?? '');
    else if (block?.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const message = { role: 'assistant', content: contentParts.join('') };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join('');
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${(anthropicBody.id ?? 'resp').replace(/^msg_/u, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: openaiModelName,
    choices: [
      {
        index: 0,
        message,
        finish_reason: CHUNK_STOP_REASON[anthropicBody.stop_reason] ?? 'stop',
      },
    ],
    usage: convertUsage(anthropicBody.usage),
  };
}

function convertUsage(usage) {
  const prompt = usage?.input_tokens ?? 0;
  const completion = usage?.output_tokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/**
 * Incremental transformer from the Anthropic SSE byte stream to the OpenAI
 * chunk byte stream. Feed raw bytes via push(); returns OpenAI-formatted
 * bytes to relay to the client.
 */
export function createStreamTransformer({ id, model, created, log }) {
  let sseBuffer = '';
  const state = {
    started: false,
    // Anthropic block index -> { type, openaiToolIndex? }
    blocks: new Map(),
    nextToolIndex: 0,
    finishReason: null,
    usagePrompt: null,
    usageOutput: 0,
    finished: false,
  };

  const chunkJson = (delta, extra = {}) =>
    JSON.stringify({ ...makeChunkBase(id, model, created), choices: [{ index: 0, delta, finish_reason: null }], ...extra });

  const wrap = (payload) => Buffer.from(payload, 'utf8');

  function handleMessage(eventName, data) {
    const out = [];
    switch (eventName) {
      case 'message_start': {
        state.started = true;
        state.usagePrompt = data?.message?.usage?.input_tokens ?? null;
        out.push(wrap(`data: ${chunkJson({ role: 'assistant', content: '' })}\n\n`));
        break;
      }
      case 'content_block_start': {
        const block = data?.content_block ?? {};
        const index = data?.index ?? 0;
        if (block.type === 'tool_use') {
          const openaiIndex = state.nextToolIndex++;
          state.blocks.set(index, { type: 'tool_use', openaiIndex });
          out.push(
            wrap(
              `data: ${chunkJson({
                tool_calls: [
                  {
                    index: openaiIndex,
                    id: block.id,
                    type: 'function',
                    function: { name: block.name ?? '', arguments: '' },
                  },
                ],
              })}\n\n`,
            ),
          );
        } else {
          state.blocks.set(index, { type: block.type ?? 'text' });
        }
        break;
      }
      case 'content_block_delta': {
        const index = data?.index ?? 0;
        const delta = data?.delta ?? {};
        const block = state.blocks.get(index);
        if (delta.type === 'text_delta' && delta.text) {
          out.push(wrap(`data: ${chunkJson({ content: delta.text })}\n\n`));
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          out.push(wrap(`data: ${chunkJson({ reasoning_content: delta.thinking })}\n\n`));
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          const openaiIndex = block?.openaiIndex ?? 0;
          out.push(
            wrap(
              `data: ${chunkJson({
                tool_calls: [
                  { index: openaiIndex, function: { arguments: delta.partial_json } },
                ],
              })}\n\n`,
            ),
          );
        } else if (delta.type === 'signature_delta') {
          // thinking signature bookkeeping — not exposed to OpenAI clients
        }
        break;
      }
      case 'content_block_stop': {
        // nothing to do; tool call boundaries are carried by indices
        break;
      }
      case 'message_delta': {
        if (data?.delta?.stop_reason) {
          state.finishReason = CHUNK_STOP_REASON[data.delta.stop_reason] ?? 'stop';
        }
        // MiniMax reports the full usage here (including input_tokens),
        // unlike vanilla Anthropic which only carries output_tokens.
        if (data?.usage?.input_tokens != null) {
          state.usagePrompt = data.usage.input_tokens;
        }
        if (data?.usage?.output_tokens != null) {
          state.usageOutput = data.usage.output_tokens;
        }
        break;
      }
      case 'message_stop': {
        state.finished = true;
        const usage = {};
        if (state.usagePrompt != null || state.usageOutput) {
          const prompt = state.usagePrompt ?? 0;
          usage.usage = {
            prompt_tokens: prompt,
            completion_tokens: state.usageOutput,
            total_tokens: prompt + state.usageOutput,
          };
        }
        out.push(
          wrap(
            `data: ${JSON.stringify({
              ...makeChunkBase(id, model, created),
              choices: [{ index: 0, delta: {}, finish_reason: state.finishReason ?? 'stop' }],
              ...usage,
            })}\n\n`,
          ),
        );
        out.push(wrap('data: [DONE]\n\n'));
        break;
      }
      case 'error': {
        const message = data?.error?.message ?? 'upstream stream error';
        log?.warn?.(`upstream SSE error event: ${message}`);
        out.push(
          wrap(
            `data: ${JSON.stringify({
              error: { message, type: data?.error?.type ?? 'upstream_error', code: null },
            })}\n\n`,
          ),
        );
        out.push(wrap('data: [DONE]\n\n'));
        state.finished = true;
        break;
      }
      case 'ping':
      case null:
      case undefined:
      default:
        break;
    }
    return out;
  }

  return {
    /** Returns Buffer of OpenAI-format bytes to forward for this input chunk. */
    push(chunk) {
      sseBuffer += chunk.toString('utf8');
      const out = [];
      let sep;
      while ((sep = sseBuffer.indexOf('\n\n')) !== -1) {
        const rawEvent = sseBuffer.slice(0, sep);
        sseBuffer = sseBuffer.slice(sep + 2);
        let eventName = null;
        const dataLines = [];
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        let data;
        try {
          data = JSON.parse(dataLines.join('\n'));
        } catch {
          continue;
        }
        out.push(...handleMessage(eventName, data));
      }
      return Buffer.concat(out);
    },
    /** Flush any buffered partial event (call on upstream end). */
    end() {
      if (state.finished) return Buffer.alloc(0);
      // Upstream closed without message_stop: synthesize a graceful finish.
      return wrap(
        `data: ${JSON.stringify({
          ...makeChunkBase(id, model, created),
          choices: [{ index: 0, delta: {}, finish_reason: state.finishReason ?? 'stop' }],
        })}\n\ndata: [DONE]\n\n`,
      );
    },
  };
}

export { CHUNK_STOP_REASON };
