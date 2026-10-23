// OpenAI Chat Completions request -> Anthropic Messages request.
// Follows the mappings used by the major "2api" gateways; unknown fields are
// dropped rather than guessed at.
import crypto from 'node:crypto';

const MAX_TOKENS_FLOOR = 1;

export function convertOpenAiToAnthropic(openaiBody, upstreamModel, modelMeta) {
  const system = [];
  const messages = [];
  let pendingToolResults = [];

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      messages.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const message of openaiBody.messages ?? []) {
    const role = message?.role;
    if (role === 'system' || role === 'developer') {
      collectSystem(message, system);
      continue;
    }
    if (role === 'user') {
      flushToolResults();
      messages.push({ role: 'user', content: convertUserContent(message.content) });
      continue;
    }
    if (role === 'assistant') {
      flushToolResults();
      messages.push(convertAssistantMessage(message));
      continue;
    }
    if (role === 'tool') {
      const content = typeof message.content === 'string' ? message.content : stringifyContent(message.content);
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: message.tool_call_id || 'toolu_unknown',
        content: [{ type: 'text', text: content }],
      });
      continue;
    }
  }
  flushToolResults();

  const body = {
    model: upstreamModel,
    max_tokens: Math.max(
      MAX_TOKENS_FLOOR,
      Number(openaiBody.max_completion_tokens ?? openaiBody.max_tokens ?? 16384) || 16384,
    ),
    messages,
  };

  if (system.length > 0) {
    body.system = system.length === 1 ? system[0] : system;
  }
  if (Array.isArray(openaiBody.stop)) {
    body.stop_sequences = openaiBody.stop.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 4);
  } else if (typeof openaiBody.stop === 'string' && openaiBody.stop) {
    body.stop_sequences = [openaiBody.stop];
  }
  if (typeof openaiBody.temperature === 'number') {
    // Anthropic accepts 0..1; OpenAI is 0..2.
    body.temperature = Math.max(0, Math.min(1, openaiBody.temperature));
  }
  if (typeof openaiBody.top_p === 'number') body.top_p = openaiBody.top_p;
  if (typeof openaiBody.stream === 'boolean') body.stream = openaiBody.stream;

  const tools = convertTools(openaiBody.tools);
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = convertToolChoice(openaiBody.tool_choice, tools.length > 0);
    if (body.tool_choice === null) {
      delete body.tool_choice;
      delete body.tools;
    }
  }

  const thinking = convertThinking(openaiBody, modelMeta);
  if (thinking) body.thinking = thinking;

  return body;
}

function collectSystem(message, out) {
  const { text } = flattenContent(message.content);
  if (text.trim()) out.push({ type: 'text', text: text.trim() });
}

function convertUserContent(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: stringifyContent(content) }];
  }
  const blocks = [];
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part?.type === 'image_url') {
      const image = convertImageUrl(part.image_url?.url ?? '');
      if (image) blocks.push(image);
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks;
}

function convertImageUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const dataMatch = /^data:([^;,]+)?(;base64)?,(.*)$/su.exec(url);
  if (dataMatch) {
    const mediaType = dataMatch[1] || 'image/png';
    if (dataMatch[2] === ';base64') {
      return {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: dataMatch[3] },
      };
    }
    return {
      type: 'image',
      source: { type: 'url', url },
    };
  }
  if (/^https?:\/\//u.test(url)) {
    return { type: 'image', source: { type: 'url', url } };
  }
  return null;
}

function convertAssistantMessage(message) {
  const blocks = [];
  const { text } = flattenContent(message.content);
  if (text) blocks.push({ type: 'text', text });
  for (const call of message.tool_calls ?? []) {
    if (call?.type !== 'function' && call?.function == null) continue;
    const fn = call.function ?? call;
    let input = {};
    try {
      input = JSON.parse(fn.arguments || '{}');
    } catch {
      input = { _raw_arguments: String(fn.arguments ?? '') };
    }
    blocks.push({
      type: 'tool_use',
      id: call.id || `toolu_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
      name: fn.name,
      input,
    });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return { role: 'assistant', content: blocks };
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    const fn = tool?.type === 'function' ? tool.function : tool?.function ? tool.function : null;
    if (!fn?.name) continue;
    out.push({
      name: fn.name,
      description: fn.description ?? '',
      input_schema: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
    });
  }
  return out;
}

function convertToolChoice(choice, hasTools) {
  if (!hasTools) return null;
  if (choice == null) return { type: 'auto' };
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return null; // signals caller to drop tools entirely
  if (typeof choice === 'object' && choice.type === 'function' && choice.function?.name) {
    return { type: 'tool', name: choice.function.name };
  }
  return { type: 'auto' };
}

function convertThinking(openaiBody, modelMeta) {
  if (openaiBody.thinking && typeof openaiBody.thinking === 'object') {
    return openaiBody.thinking; // direct Anthropic-style passthrough
  }
  const effort = openaiBody.reasoning_effort ?? openaiBody.reasoning;
  if (effort == null) return null;
  if (modelMeta?.thinking === 'switchable') {
    if (effort === 'none' || effort === 'minimal' || effort === 'off' || effort === 'disabled') {
      return { type: 'disabled' };
    }
    return { type: 'enabled' };
  }
  if (effort === 'none' || effort === 'off' || effort === 'disabled') {
    // Forced-thinking models cannot disable; ignore instead of erroring.
    return null;
  }
  return null;
}

function flattenContent(content) {
  if (typeof content === 'string') return { text: content };
  if (Array.isArray(content)) {
    return {
      text: content
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n'),
    };
  }
  if (content == null) return { text: '' };
  return { text: stringifyContent(content) };
}

function stringifyContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
