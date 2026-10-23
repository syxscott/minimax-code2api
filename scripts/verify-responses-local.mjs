// Local (no-network) tests for the Responses API converters.
import { responsesToChat } from '../src/convert/responses-to-chat.js';
import { convertOpenAiToAnthropic } from '../src/convert/openai-to-anthropic.js';
import { convertNonStreamResponse, createResponsesStreamTransformer } from '../src/convert/chat-to-responses.js';

const J = JSON.stringify;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── R1: full request conversion ──────────────────────────────────────────
{
  const body = {
    model: 'MiniMax-M3',
    instructions: 'You are a coding agent.',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thinking…' }] },
      { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call', call_id: 'call_b', name: 'shell', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'a.txt\nb.txt' },
      { type: 'function_call_output', call_id: 'call_b', output: '/tmp' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] },
      { type: 'message', role: 'user', content: 'thanks, continue' },
    ],
    tools: [
      { type: 'function', name: 'shell', description: 'run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
      { type: 'web_search' }, // hosted — must be dropped
    ],
    tool_choice: 'auto',
    max_output_tokens: 512,
    temperature: 0.7,
    stream: true,
    reasoning: { effort: 'medium', summary: 'auto' },
  };
  const chat = responsesToChat(body);
  const customNames = chat.__customToolNames ?? new Set();
  delete chat.__customToolNames;
  const anthropic = convertOpenAiToAnthropic(chat, 'MiniMax-M3', { thinking: 'switchable' });

  const roles = anthropic.messages.map((m) => m.role).join(',');
  check('R1 roles', roles === 'user,assistant,user,assistant,user', roles);
  const sys = anthropic.system;
  const sysText = Array.isArray(sys) ? sys.map((b) => b.text).join('') : sys?.text;
  check('R1 system', sysText === 'You are a coding agent.');
  const toolUses = anthropic.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_use') : []);
  check('R1 tool_use merged', toolUses.length === 2 && toolUses[0].id === 'call_a' && toolUses[1].id === 'call_b', toolUses.map((t) => t.id).join(','));
  const toolResults = anthropic.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : []);
  check('R1 tool_results', toolResults.length === 2 && toolResults[0].tool_use_id === 'call_a');
  check('R1 tools filtered', anthropic.tools?.length === 1 && anthropic.tools[0].name === 'shell');
  check('R1 thinking on', J(anthropic.thinking) === J({ type: 'enabled' }), J(anthropic.thinking));
  check('R1 max_tokens', anthropic.max_tokens === 512);
  check('R1 stream', anthropic.stream === true);
}

// ── R2: custom tool wrap/unwrap ──────────────────────────────────────────
{
  const body = {
    model: 'MiniMax-M3',
    input: [{ type: 'message', role: 'user', content: 'apply patch' }],
    tools: [{ type: 'custom', name: 'apply_patch', description: 'patch it' }],
  };
  const chat = responsesToChat(body);
  const customNames = chat.__customToolNames;
  delete chat.__customToolNames;
  check('R2 custom detected', customNames.has('apply_patch'));
  check('R2 wrapped as function', chat.tools?.[0]?.function?.name === 'apply_patch' && chat.tools[0].function.parameters.required?.[0] === 'input');
  const item = convertNonStreamResponse(
    { content: [{ type: 'tool_use', id: 'toolu_1', name: 'apply_patch', input: { input: '*** Begin Patch' } }], stop_reason: 'tool_use', usage: {} },
    'MiniMax-M3',
    customNames,
  );
  check('R2 unwrapped to custom_tool_call', item.output[0].type === 'custom_tool_call' && item.output[0].input === '*** Begin Patch', J(item.output[0]).slice(0, 80));
}

// ── R3: non-stream full response ─────────────────────────────────────────
{
  const resp = convertNonStreamResponse(
    {
      id: 'msg_1',
      content: [
        { type: 'text', id: 'b1', text: 'hello world' },
        { type: 'tool_use', id: 'toolu_9', name: 'shell', input: { cmd: 'ls' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 42, output_tokens: 7 },
    },
    'MiniMax-M3',
    new Set(),
  );
  check('R3 status', resp.status === 'completed' && resp.object === 'response');
  check('R3 output order', resp.output.map((o) => o.type).join(',') === 'message,function_call', resp.output.map((o) => o.type).join(','));
  check('R3 call_id preserved', resp.output[1].call_id === 'toolu_9' && resp.output[1].arguments === J({ cmd: 'ls' }));
  check('R3 usage', resp.usage.input_tokens === 42 && resp.usage.total_tokens === 49);
}

// ── R4: streaming event sequence (canned anthropic stream) ───────────────
{
  const t = createResponsesStreamTransformer({ model: 'MiniMax-M3', created: 1, customToolNames: new Set(), log: console });
  const anth = [
    `event: message_start\ndata: ${J({ type: 'message_start', message: { usage: { input_tokens: 10 } } })}\n\n`,
    `event: content_block_start\ndata: ${J({ type: 'content_block_start', index: 0, content_block: { type: 'text', id: 'b1' } })}\n\n`,
    `event: content_block_delta\ndata: ${J({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } })}\n\n`,
    `event: content_block_delta\ndata: ${J({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } })}\n\n`,
    `event: content_block_stop\ndata: ${J({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: content_block_start\ndata: ${J({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_5', name: 'shell' } })}\n\n`,
    `event: content_block_delta\ndata: ${J({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } })}\n\n`,
    `event: content_block_delta\ndata: ${J({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ls"}' } })}\n\n`,
    `event: content_block_stop\ndata: ${J({ type: 'content_block_stop', index: 1 })}\n\n`,
    `event: message_delta\ndata: ${J({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 42, output_tokens: 9 } })}\n\n`,
    `event: message_stop\ndata: ${J({ type: 'message_stop' })}\n\n`,
  ].join('');
  const out = (t.push(anth) + t.end()).toString();
  const events = out.split('\n\n').filter(Boolean).map((e) => {
    const type = e.match(/^event: (.+)$/m)?.[1];
    const data = JSON.parse(e.replace(/^event: .+\n/m, '').replace('data: ', ''));
    return { type, data };
  });
  const types = events.map((e) => e.type);
  check('R4 event order', types.join(',') === [
    'response.created', 'response.in_progress',
    'response.output_item.added', 'response.content_part.added',
    'response.output_text.delta', 'response.output_text.delta',
    'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
    'response.output_item.added',
    'response.function_call_arguments.delta', 'response.function_call_arguments.delta',
    'response.function_call_arguments.done', 'response.output_item.done',
    'response.completed',
  ].join(','), types.join(','));
  const completed = events.at(-1).data.response;
  check('R4 completed usage', completed.usage.input_tokens === 42 && completed.usage.output_tokens === 9 && completed.usage.total_tokens === 51);
  check('R4 completed output', completed.output.length === 2 && completed.output[0].type === 'message' && completed.output[1].call_id === 'toolu_5' && completed.output[1].arguments === '{"cmd":"ls"}');
  check('R4 text deltas', events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.data.delta).join('') === 'Hi there');
  check('R4 sequence numbers', events.every((e, i) => e.data.sequence_number === i + 1));
}

// ── R5: truncated upstream → response.incomplete ─────────────────────────
{
  const t = createResponsesStreamTransformer({ model: 'm', created: 1, customToolNames: new Set(), log: console });
  t.push(`event: message_start\ndata: ${J({ type: 'message_start' })}\n\n`);
  t.push(`event: content_block_start\ndata: ${J({ type: 'content_block_start', index: 0, content_block: { type: 'text', id: 'b1' } })}\n\n`);
  const tail = t.end().toString();
  check('R5 incomplete on truncation', tail.includes('response.incomplete') && tail.includes('"status":"incomplete"'));
}

console.log(failed === 0 ? '\nALL LOCAL RESPONSES TESTS PASSED' : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
