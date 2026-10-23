// Anthropic Messages response / SSE -> OpenAI Responses API.
// Complements responses-to-chat.js. Streaming emits the event sequence Codex
// CLI consumes: response.created → per-item added/delta/done → completed.
import crypto from 'node:crypto';

function genId(prefix) {
  return `${prefix}${crypto.randomBytes(16).toString('hex')}`;
}

const STOP_TO_STATUS = {
  end_turn: 'completed',
  stop_sequence: 'completed',
  tool_use: 'completed',
  max_tokens: 'incomplete',
  refusal: 'completed',
};

function usageToResponses(usage) {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: usage?.cache_read_input_tokens ?? 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

function messageItem(id, text) {
  return {
    type: 'message',
    id,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function functionCallItem(blockId, name, argsJson, customToolNames) {
  if (customToolNames?.has(name)) {
    let input = '';
    try {
      input = String(JSON.parse(argsJson || '{}').input ?? '');
    } catch {
      input = argsJson ?? '';
    }
    return { type: 'custom_tool_call', id: `item_${blockId}`, call_id: blockId, name, input, status: 'completed' };
  }
  return { type: 'function_call', id: `item_${blockId}`, call_id: blockId, name, arguments: argsJson, status: 'completed' };
}

function reasoningItem(blockId, thinking) {
  return {
    type: 'reasoning',
    id: `item_${blockId}`,
    summary: thinking ? [{ type: 'summary_text', text: thinking }] : [],
    status: 'completed',
  };
}

/** Build output[] in Anthropic block order (reasoning/text interleaved). */
function buildOutput(contentBlocks, customToolNames) {
  const items = [];
  for (const block of contentBlocks ?? []) {
    if (block.type === 'thinking') items.push(reasoningItem(block.id ?? genId('blk'), block.thinking ?? ''));
    else if (block.type === 'text') items.push(messageItem(`item_${block.id ?? genId('blk')}`, block.text ?? ''));
    else if (block.type === 'tool_use') {
      items.push(functionCallItem(block.id ?? genId('blk'), block.name ?? '', JSON.stringify(block.input ?? {}), customToolNames));
    }
  }
  return items;
}

export function convertNonStreamResponse(anthropicBody, model, customToolNames) {
  const status = STOP_TO_STATUS[anthropicBody.stop_reason] ?? 'completed';
  return {
    id: genId('resp_'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    output: buildOutput(anthropicBody.content, customToolNames),
    usage: usageToResponses(anthropicBody.usage),
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    parallel_tool_calls: false,
  };
}

/**
 * Streaming: Anthropic SSE bytes in, Responses SSE bytes out.
 * Anthropic blocks map to Responses output items in index order; item ids
 * derive from Anthropic block ids so tool call_ids survive the round trip.
 */
export function createResponsesStreamTransformer({ model, created, customToolNames, log }) {
  const responseId = genId('resp_');
  let sseBuffer = '';
  let seq = 0;
  const state = {
    started: false,
    blocks: new Map(), // anthropic block index -> { type, itemId, textAcc, argsAcc, openaiIndex }
    outputIndex: 0,
    outputItems: [],
    finishStatus: 'completed',
    usagePrompt: null,
    usageOutput: 0,
    finished: false,
  };

  const frame = (event) => {
    seq += 1;
    return Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify({ sequence_number: seq, ...event })}\n\n`, 'utf8');
  };

  const emit = (parts, out) => {
    for (const p of parts) out.push(frame(p));
  };

  const incompleteDetails = () =>
    state.finishStatus === 'incomplete' ? { reason: 'max_output_tokens' } : undefined;

  const finalResponse = () => ({
    id: responseId,
    object: 'response',
    created_at: created,
    model,
    status: state.finishStatus,
    output: state.outputItems,
    usage: usageToResponses({ input_tokens: state.usagePrompt, output_tokens: state.usageOutput }),
    ...(incompleteDetails() ? { incomplete_details: incompleteDetails() } : {}),
    parallel_tool_calls: false,
  });

  function handle(eventName, data) {
    const out = [];
    switch (eventName) {
      case 'message_start': {
        state.started = true;
        state.usagePrompt = data?.message?.usage?.input_tokens ?? null;
        emit([
          { type: 'response.created', response: { ...finalResponse(), status: 'in_progress', output: [], usage: undefined } },
          { type: 'response.in_progress', response: { ...finalResponse(), status: 'in_progress', output: [], usage: undefined } },
        ], out);
        break;
      }
      case 'content_block_start': {
        const block = data?.content_block ?? {};
        const index = data?.index ?? 0;
        const itemId = `item_${block.id ?? genId('blk')}`;
        const openaiIndex = state.outputIndex++;
        if (block.type === 'tool_use') {
          const isCustom = customToolNames?.has(block.name ?? '');
          state.blocks.set(index, { type: 'tool_use', itemId, openaiIndex, name: block.name ?? '', argsAcc: '', isCustom });
          const base = isCustom
            ? { type: 'custom_tool_call', id: itemId, call_id: block.id, name: block.name ?? '', input: '', status: 'in_progress' }
            : { type: 'function_call', id: itemId, call_id: block.id, name: block.name ?? '', arguments: '', status: 'in_progress' };
          emit([{ type: 'response.output_item.added', output_index: openaiIndex, item: base }], out);
        } else if (block.type === 'thinking') {
          state.blocks.set(index, { type: 'thinking', itemId, openaiIndex, textAcc: '' });
          emit([
            { type: 'response.output_item.added', output_index: openaiIndex, item: { type: 'reasoning', id: itemId, summary: [], status: 'in_progress' } },
            { type: 'response.reasoning_summary_part.added', output_index: openaiIndex, summary_index: 0, item_id: itemId, part: { type: 'summary_text', text: '' } },
          ], out);
        } else {
          state.blocks.set(index, { type: 'text', itemId, openaiIndex, textAcc: '' });
          emit([
            { type: 'response.output_item.added', output_index: openaiIndex, item: { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [] } },
            { type: 'response.content_part.added', output_index: openaiIndex, content_index: 0, item_id: itemId, part: { type: 'output_text', text: '', annotations: [] } },
          ], out);
        }
        break;
      }
      case 'content_block_delta': {
        const index = data?.index ?? 0;
        const delta = data?.delta ?? {};
        const block = state.blocks.get(index);
        if (!block) break;
        if (delta.type === 'text_delta' && delta.text) {
          block.textAcc += delta.text;
          emit([
            { type: 'response.output_text.delta', output_index: block.openaiIndex, content_index: 0, delta: delta.text, item_id: block.itemId },
          ], out);
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          block.textAcc += delta.thinking;
          emit([
            { type: 'response.reasoning_summary_text.delta', output_index: block.openaiIndex, summary_index: 0, delta: delta.thinking, item_id: block.itemId },
          ], out);
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          block.argsAcc += delta.partial_json;
          const base = { output_index: block.openaiIndex, delta: delta.partial_json, item_id: block.itemId, call_id: block.callId, name: block.name };
          emit([{ type: 'response.function_call_arguments.delta', ...base }], out);
        }
        break;
      }
      case 'content_block_stop': {
        const index = data?.index ?? 0;
        const block = state.blocks.get(index);
        if (!block) break;
        if (block.type === 'text') {
          state.outputItems[block.openaiIndex] = messageItem(block.itemId, block.textAcc);
          emit([
            { type: 'response.output_text.done', output_index: block.openaiIndex, content_index: 0, text: block.textAcc, item_id: block.itemId },
            { type: 'response.content_part.done', output_index: block.openaiIndex, content_index: 0, item_id: block.itemId, part: { type: 'output_text', text: block.textAcc, annotations: [] } },
            { type: 'response.output_item.done', output_index: block.openaiIndex, item: state.outputItems[block.openaiIndex] },
          ], out);
        } else if (block.type === 'thinking') {
          state.outputItems[block.openaiIndex] = reasoningItem(block.itemId, block.textAcc);
          emit([
            { type: 'response.reasoning_summary_text.done', output_index: block.openaiIndex, summary_index: 0, text: block.textAcc, item_id: block.itemId },
            { type: 'response.reasoning_summary_part.done', output_index: block.openaiIndex, summary_index: 0, item_id: block.itemId, part: { type: 'summary_text', text: block.textAcc } },
            { type: 'response.output_item.done', output_index: block.openaiIndex, item: state.outputItems[block.openaiIndex] },
          ], out);
        } else if (block.type === 'tool_use') {
          const doneItem = functionCallItem(block.itemId.replace(/^item_/u, ''), block.name, block.argsAcc || '{}', customToolNames);
          doneItem.id = block.itemId;
          state.outputItems[block.openaiIndex] = doneItem;
          if (doneItem.type === 'custom_tool_call') {
            emit([
              { type: 'response.custom_tool_call_input.done', output_index: block.openaiIndex, input: doneItem.input, item_id: block.itemId, call_id: doneItem.call_id, name: block.name },
              { type: 'response.output_item.done', output_index: block.openaiIndex, item: doneItem },
            ], out);
          } else {
            emit([
              { type: 'response.function_call_arguments.done', output_index: block.openaiIndex, arguments: doneItem.arguments, item_id: block.itemId, call_id: doneItem.call_id, name: block.name },
              { type: 'response.output_item.done', output_index: block.openaiIndex, item: doneItem },
            ], out);
          }
        }
        state.blocks.delete(index);
        break;
      }
      case 'message_delta': {
        if (data?.delta?.stop_reason) {
          state.finishStatus = STOP_TO_STATUS[data.delta.stop_reason] ?? 'completed';
        }
        if (data?.usage?.input_tokens != null) state.usagePrompt = data.usage.input_tokens;
        if (data?.usage?.output_tokens != null) state.usageOutput = data.usage.output_tokens;
        break;
      }
      case 'message_stop': {
        state.finished = true;
        emit([{ type: 'response.completed', response: finalResponse() }], out);
        break;
      }
      case 'error': {
        state.finished = true;
        const message = data?.error?.message ?? 'upstream stream error';
        log?.warn?.(`upstream SSE error event: ${message}`);
        emit([{
          type: 'response.failed',
          response: { ...finalResponse(), status: 'failed', error: { code: data?.error?.type ?? 'upstream_error', message } },
          error: { code: data?.error?.type ?? 'upstream_error', message },
        }], out);
        break;
      }
      default:
        break;
    }
    return out;
  }

  return {
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
        out.push(...handle(eventName, data));
      }
      return Buffer.concat(out);
    },
    end() {
      if (state.finished) return Buffer.alloc(0);
      // Upstream closed without message_stop: close open items, then
      // report incomplete rather than hanging the client.
      const out = [];
      for (const block of state.blocks.values()) {
        state.outputItems[block.openaiIndex] =
          block.type === 'text' ? messageItem(block.itemId, block.textAcc)
          : block.type === 'thinking' ? reasoningItem(block.itemId, block.textAcc)
          : functionCallItem(block.itemId.replace(/^item_/u, ''), block.name, block.argsAcc || '{}', customToolNames);
        out.push(frame({ type: 'response.output_item.done', output_index: block.openaiIndex, item: state.outputItems[block.openaiIndex] }));
      }
      state.blocks.clear();
      if (state.finishStatus === 'completed') state.finishStatus = 'incomplete';
      emit([{ type: 'response.incomplete', response: finalResponse() }], out);
      return Buffer.concat(out);
    },
  };
}

export { STOP_TO_STATUS };
