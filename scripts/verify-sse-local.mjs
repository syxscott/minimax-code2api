// Local (no-network) edge tests for the SSE transformer.
import { createStreamTransformer } from '../src/convert/anthropic-to-openai.js';

const J = JSON.stringify;

// S1: canned real MiniMax stream, with one frame split mid-JSON across chunks.
const fullDelta = `event: content_block_delta\ndata: ${J({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } })}\n\n`;
const cut = 55; // arbitrary split point inside the JSON payload
const raw = [
  `event: message_start\ndata: ${J({ type: 'message_start', message: { usage: { input_tokens: 0 } } })}\n\n`,
  `event: ping\ndata: ${J({ type: 'ping' })}\n\n`,
  `event: content_block_start\ndata: ${J({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })}\n\n`,
  fullDelta.slice(0, cut),
  fullDelta.slice(cut),
  `event: message_delta\ndata: ${J({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 37, output_tokens: 9 } })}\n\n`,
  `event: message_stop\ndata: ${J({ type: 'message_stop' })}\n\n`,
];

const t = createStreamTransformer({ id: 'test', model: 'm', created: 1, log: console });
let out = '';
for (const part of raw) out += t.push(part).toString();
out += t.end().toString();
const events = out.split('\n\n').filter(Boolean);
const last = JSON.parse(events[events.length - 2].replace('data: ', ''));
console.log('S1 frames:', events.length, '| finish:', last.choices[0].finish_reason, '| usage:', J(last.usage));
const textFrames = events.filter((e) => e.includes('"content"')).map((e) => JSON.parse(e.replace('data: ', '')).choices[0].delta.content).join('');
console.log('S1 reassembled text:', JSON.stringify(textFrames));

// S2: truncated upstream (dies mid-generation) -> graceful DONE.
const t2 = createStreamTransformer({ id: 't2', model: 'm', created: 1, log: console });
t2.push(`event: message_start\ndata: ${J({ type: 'message_start' })}\n\n`);
t2.push(`event: content_block_delta\ndata: ${J({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'par' } })}\n\n`);
const tail2 = t2.end().toString();
console.log('S2 truncated -> DONE:', tail2.includes('[DONE]'), '| graceful finish:', tail2.includes('"finish_reason"'));
