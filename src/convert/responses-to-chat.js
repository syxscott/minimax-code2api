// OpenAI Responses API request -> Chat Completions body. Codex CLI speaks
// Responses (wire_api = "responses"); we lower it to Chat Completions so the
// existing Chat -> Anthropic converter can carry it upstream.
//
// Scope: message / function_call / function_call_output input items, function
// and custom tools, reasoning.effort. Hosted tools (web_search, file_search,
// code_interpreter, mcp, ...) are dropped — upstream cannot serve them.
import crypto from 'node:crypto';

export function responsesToChat(body) {
  const messages = [];

  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }

  const inputItems = Array.isArray(body.input)
    ? body.input
    : typeof body.input === 'string'
      ? [{ type: 'message', role: 'user', content: body.input }]
      : [];

  let pendingAssistantToolCalls = null;
  let pendingToolResults = null;
  const flushToolCalls = () => {
    if (pendingAssistantToolCalls) {
      messages.push({ role: 'assistant', content: '', tool_calls: pendingAssistantToolCalls });
      pendingAssistantToolCalls = null;
    }
  };
  // Anthropic requires tool_result blocks in the message immediately after
  // the assistant tool_use turn, so outputs are grouped and flushed together
  // before the next non-tool item.
  const flushToolResults = () => {
    if (pendingToolResults) {
      flushToolCalls();
      for (const r of pendingToolResults) {
        messages.push({ role: 'tool', tool_call_id: r.tool_call_id, content: r.content });
      }
      pendingToolResults = null;
    }
  };
  const flushAll = () => {
    flushToolResults();
    flushToolCalls();
  };

  for (const item of inputItems) {
    if (item?.type === 'message') {
      flushAll();
      const role = item.role === 'developer' || item.role === 'system'
        ? 'system'
        : item.role === 'assistant'
          ? 'assistant'
          : 'user';
      const chatMessage = { role, content: convertMessageContent(role, item.content) };
      messages.push(chatMessage);
    } else if (item?.type === 'function_call') {
      flushToolResults();
      // Merge consecutive function_call items into one assistant turn.
      if (!pendingAssistantToolCalls) pendingAssistantToolCalls = [];
      pendingAssistantToolCalls.push({
        id: item.call_id || `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
        type: 'function',
        function: { name: item.name, arguments: item.arguments ?? '{}' },
      });
    } else if (item?.type === 'function_call_output') {
      if (!pendingToolResults) pendingToolResults = [];
      pendingToolResults.push({
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : stringify(item.output),
      });
    } else if (item?.type === 'custom_tool_call') {
      flushToolResults();
      if (!pendingAssistantToolCalls) pendingAssistantToolCalls = [];
      pendingAssistantToolCalls.push({
        id: item.call_id || `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
        type: 'function',
        function: { name: item.name, arguments: stringify({ input: item.input ?? '' }) },
      });
    } else if (item?.type === 'custom_tool_call_output') {
      if (!pendingToolResults) pendingToolResults = [];
      pendingToolResults.push({
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : stringify(item.output),
      });
    }
    // reasoning / web_search_call / other upstream-irrelevant items: skipped.
  }
  flushAll();

  const chat = { messages };
  if (Array.isArray(body.tools)) {
    const customNames = new Set(
      body.tools.filter((t) => t?.type === 'custom' && t.name).map((t) => t.name),
    );
    const functions = [];
    for (const tool of body.tools) {
      if (tool?.type === 'function' && tool.name) {
        functions.push(wrapFunctionTool(tool.name, tool.description, tool.parameters));
      } else if (tool?.type === 'custom' && tool.name) {
        // Freeform custom tools take a single string input; model-side they
        // become ordinary functions with one required "input" parameter.
        functions.push(wrapFunctionTool(
          tool.name,
          tool.description,
          { type: 'object', properties: { input: { type: 'string', description: 'Complete tool input as a single string' } }, required: ['input'] },
        ));
      }
      // hosted tools (web_search / file_search / code_interpreter / mcp / ...): dropped
    }
    if (functions.length > 0) chat.tools = functions;
    chat.__customToolNames = customNames; // consumed by the route, stripped before upstream
  }

  if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice;
  if (Number.isFinite(body.max_output_tokens)) chat.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === 'number') chat.temperature = body.temperature;
  if (typeof body.top_p === 'number') chat.top_p = body.top_p;
  if (typeof body.stream === 'boolean') chat.stream = body.stream;
  if (body.reasoning && typeof body.reasoning === 'object' && body.reasoning.effort) {
    chat.reasoning_effort = body.reasoning.effort;
  }
  if (typeof body.user === 'string' && body.user) chat.user = body.user;

  return chat;
}

function wrapFunctionTool(name, description, parameters) {
  return {
    type: 'function',
    function: {
      name,
      description: description ?? '',
      parameters: parameters && typeof parameters === 'object' ? parameters : { type: 'object', properties: {} },
    },
  };
}

function convertMessageContent(role, content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringify(content);
  if (role === 'assistant') {
    return content
      .filter((p) => p?.type === 'output_text' || p?.type === 'text')
      .map((p) => p.text ?? '')
      .join('');
  }
  const parts = [];
  for (const part of content) {
    if ((part?.type === 'input_text' || part?.type === 'text') && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
    } else if (part?.type === 'input_image' || part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url ?? part.url;
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  if (parts.length === 0) parts.push({ type: 'text', text: '' });
  return parts;
}

function stringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
