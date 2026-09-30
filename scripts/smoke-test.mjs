#!/usr/bin/env node
// End-to-end smoke test for minimax-code2api.
//
// Usage: node scripts/smoke-test.mjs [baseUrl]
//
// Designed to be non-intrusive: a handful of tiny requests (max_tokens <= 64),
// paced with short delays, and it records the desktop broker's token
// generation before/after — if the generation is unchanged, the proxy test
// run did not trigger any credential refresh on the desktop side.

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8045').replace(/\/+$/u, '');
const API_KEY = process.env.M2A_API_KEY ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let brokerGenerationBefore = null;

function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    ...extra,
  };
}

async function getStatus() {
  const res = await fetch(`${BASE}/v1/status`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function readSse(res, { maxEvents = 200, abortAfter = null } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const events = [];
  try {
    while (events.length < maxEvents) {
      const { done: readerDone, value } = await reader.read();
      if (readerDone) {
        // Anthropic streams end by closing the connection (no [DONE] sentinel).
        return { events, done: true };
      }
      text += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = text.indexOf('\n\n')) !== -1) {
        const raw = text.slice(0, sep);
        text = text.slice(sep + 2);
        events.push(raw);
        if (raw.includes('[DONE]')) return { events, done: true };
        if (abortAfter != null && events.length >= abortAfter) {
          await reader.cancel();
          return { events, done: false, aborted: true };
        }
      }
    }
  } catch (error) {
    if (abortAfter == null) throw error;
    return { events, done: false, aborted: true, error };
  }
  return { events, done: false };
}

async function main() {
  // ---- pre-flight ---------------------------------------------------------
  const statusBefore = await getStatus();
  brokerGenerationBefore = statusBefore.broker?.generation ?? null;
  console.log(`broker generation before: ${brokerGenerationBefore} (${statusBefore.broker?.status})`);

  // ---- T1 health ----------------------------------------------------------
  {
    const res = await fetch(`${BASE}/health`);
    const body = await res.json();
    record('T1 health', res.status === 200 && body.status === 'ok');
  }

  // ---- T2 models ----------------------------------------------------------
  {
    const res = await fetch(`${BASE}/v1/models`, { headers: headers() });
    const body = await res.json();
    const ids = (body.data ?? []).map((m) => m.id);
    record(
      'T2 models list',
      res.status === 200 && ids.includes('MiniMax-M3') && ids.includes('MiniMax-M2.7'),
      ids.join(','),
    );
  }

  await sleep(800);

  // ---- T3 anthropic non-stream ---------------------------------------------
  {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: 'MiniMax-M3',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
      }),
    });
    const body = await res.json();
    const text = body.content?.map((b) => b.text ?? '').join('') ?? '';
    record('T3 anthropic non-stream', res.status === 200 && body.type === 'message' && text.length > 0, `reply="${text.slice(0, 24)}"`);
  }

  await sleep(800);

  // ---- T4 anthropic stream --------------------------------------------------
  {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: 'MiniMax-M3',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'Say OK' }],
      }),
    });
    const { events, done } = await readSse(res);
    const hasStart = events.some((e) => e.includes('message_start'));
    const hasStop = events.some((e) => e.includes('message_stop'));
    record('T4 anthropic stream passthrough', res.status === 200 && done && hasStart && hasStop, `${events.length} events`);
  }

  await sleep(800);

  // ---- T5 openai non-stream --------------------------------------------------
  {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: 'gpt-4o', // unknown on purpose — must map to default model
        max_tokens: 32,
        messages: [{ role: 'user', content: 'Reply with exactly: pong-openai' }],
      }),
    });
    const body = await res.json();
    record(
      'T5 openai non-stream + model aliasing',
      res.status === 200 && body.object === 'chat.completion' && body.choices?.[0]?.message?.content?.length > 0,
      `model echoed as ${body.model}`,
    );
  }

  await sleep(800);

  // ---- T6 openai stream -------------------------------------------------------
  {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: 'MiniMax-M3',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'Say OK' }],
      }),
    });
    const { events, done } = await readSse(res);
    const hasDone = events.some((e) => e.includes('[DONE]'));
    const usageChunk = events.find((e) => e.includes('"finish_reason":"stop"') && e.includes('"usage"'));
    record('T6 openai stream + usage', res.status === 200 && done && hasDone && usageChunk != null);
  }

  await sleep(800);

  // ---- T7 tool calling ----------------------------------------------------------
  {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: 'MiniMax-M3',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get current weather for a city',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          },
        ],
      }),
    });
    const body = await res.json();
    const call = body.choices?.[0]?.message?.tool_calls?.[0];
    const ok =
      res.status === 200 &&
      body.choices?.[0]?.finish_reason === 'tool_calls' &&
      call?.function?.name === 'get_weather';
    let argsValid = false;
    try {
      argsValid = ok && JSON.parse(call.function.arguments).city.length > 0;
    } catch {}
    record('T7 openai tool call', ok && argsValid, call ? `args=${call.function.arguments}` : 'no tool call');
  }

  await sleep(800);

  // ---- T8 count_tokens (local estimate, no upstream call) -------------------------
  {
    const res = await fetch(`${BASE}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hello world' }] }),
    });
    const body = await res.json();
    record('T8 count_tokens', res.status === 200 && Number.isFinite(body.input_tokens) && body.input_tokens > 0, `${body.input_tokens}`);
  }

  // ---- T9 error handling: bad JSON, unknown route ----------------------------------
  {
    const res = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: headers(), body: '{oops' });
    record('T9a invalid JSON -> 400', res.status === 400);
    const res2 = await fetch(`${BASE}/v1/nope`, { headers: headers() });
    record('T9b unknown route -> 404', res2.status === 404);
  }

  // ---- T10 client abort mid-stream (proxy must clean up, stay alive) ---------------
  {
    const controller = new AbortController();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      signal: controller.signal,
      body: JSON.stringify({
        model: 'MiniMax-M3',
        max_tokens: 2048,
        stream: true,
        messages: [{ role: 'user', content: 'Count slowly from 1 to 200, one number per line.' }],
      }),
    });
    const { aborted } = await readSse(res, { abortAfter: 2 });
    controller.abort();
    await sleep(500);
    const stillAlive = await fetch(`${BASE}/health`).then((r) => r.ok);
    record('T10 client abort survives', aborted && stillAlive);
  }

  await sleep(800);

  // ---- T11 mild concurrency (3 parallel tiny requests) -------------------------------
  {
    const jobs = [1, 2, 3].map((i) =>
      fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          model: 'MiniMax-M3',
          max_tokens: 16,
          messages: [{ role: 'user', content: `Reply with the number ${i}` }],
        }),
      }).then(async (r) => ({ status: r.status, body: await r.json() })),
    );
    const settled = await Promise.allSettled(jobs);
    const ok = settled.filter((s) => s.value?.status === 200).length;
    record('T11 concurrency x3', ok === 3, `${ok}/3 ok`);
  }

  await sleep(1500);

  // ---- post-flight: broker generation must be unchanged -------------------------------
  const statusAfter = await getStatus();
  const generationAfter = statusAfter.broker?.generation ?? null;
  record(
    'T12 broker generation unchanged (no refresh triggered)',
    generationAfter === brokerGenerationBefore,
    `${brokerGenerationBefore} -> ${generationAfter}`,
  );

  // ---- summary -------------------------------------------------------------------------
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('failed:', failed.map((f) => f.name).join(', '));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('smoke test crashed:', error);
  process.exit(1);
});
