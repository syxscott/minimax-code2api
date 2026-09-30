// Admin / observability routes: dashboard, health, live status.
import { anthropicMessagesUrl, resolveUpstreamOrigin } from '../config.js';
import { sendJson } from '../http-utils.js';

export function handleHealth(res) {
  sendJson(res, 200, { status: 'ok' });
}

export async function handleStatus(res, ctx) {
  const { config, tokenManager, stats, startedAt } = ctx;
  const payload = {
    service: 'minimax-code2api',
    version: '0.1.0',
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    upstream: {
      origin: resolveUpstreamOrigin(config),
      messages_url: anthropicMessagesUrl(config),
      region: config.region,
    },
    broker: null,
    stats,
  };
  try {
    const status = await tokenManager.getStatus();
    payload.broker = {
      reachable: true,
      status: status.status,
      generation: status.generation,
      expires_at_ms: status.expiresAtMs ?? null,
      expires_in_seconds: status.expiresAtMs
        ? Math.max(0, Math.round((status.expiresAtMs - Date.now()) / 1000))
        : null,
    };
  } catch (error) {
    payload.broker = {
      reachable: false,
      status: 'unreachable',
      error: error.message,
    };
  }
  sendJson(res, 200, payload);
}

const PAGE_REFRESH_MS = 5000;

export function handleDashboard(res, ctx) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>minimax-code2api</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: "Segoe UI", system-ui, sans-serif; background:#0f1420; color:#dbe2f0;
         margin:0; padding:40px 16px; display:flex; justify-content:center; }
  .card { background:#161d2e; border:1px solid #232d44; border-radius:14px; padding:28px 32px;
          width:100%; max-width:640px; box-shadow:0 8px 30px rgba(0,0,0,.35); }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#7d8aa5; font-size:13px; margin-bottom:22px; }
  .row { display:flex; justify-content:space-between; padding:9px 0; border-bottom:1px solid #1d2637; font-size:14px; }
  .row:last-child { border-bottom:none; }
  .k { color:#8fa0bf; }
  .v { font-family: ui-monospace, Consolas, monospace; }
  .ok { color:#5dd39e; } .bad { color:#ef6b73; } .warn { color:#e8b45a; }
  .endpoints { margin-top:20px; font-size:13px; color:#7d8aa5; line-height:1.7; }
  code { background:#0f1420; padding:2px 6px; border-radius:5px; color:#a8c0ee; }
</style>
</head>
<body>
  <div class="card">
    <h1>minimax-code2api</h1>
    <div class="sub">MiniMax Code Coding Plan → Anthropic / OpenAI 兼容网关</div>
    <div id="content"><div class="row"><span class="k">加载中…</span></div></div>
    <div class="endpoints">
      Anthropic:&nbsp;<code>POST /v1/messages</code> &nbsp;·&nbsp; OpenAI:&nbsp;<code>POST /v1/chat/completions</code><br/>
      模型列表:&nbsp;<code>GET /v1/models</code> &nbsp;·&nbsp; 状态:&nbsp;<code>GET /v1/status</code> &nbsp;·&nbsp; 健康:&nbsp;<code>GET /health</code>
    </div>
  </div>
<script>
async function refresh() {
  try {
    const r = await fetch('/v1/status');
    const s = await r.json();
    const b = s.broker || {};
    const cls = b.status === 'authenticated' ? 'ok' : (b.reachable ? 'warn' : 'bad');
    const rows = [
      ['Broker 状态', \`<span class="\${cls}">\${esc(b.status ?? 'unknown')}</span>\`],
      ['Token 代际', b.generation ?? '—'],
      ['Token 剩余', b.expires_in_seconds != null ? b.expires_in_seconds + 's' : '—'],
      ['上游', esc(s.upstream?.origin ?? '')],
      ['区域', esc(s.upstream?.region ?? '')],
      ['Anthropic 请求', s.stats?.anthropic?.requests ?? 0],
      ['OpenAI 请求', s.stats?.openai?.requests ?? 0],
      ['运行时间', Math.floor((s.uptime_seconds ?? 0) / 60) + ' 分钟'],
    ];
    document.getElementById('content').innerHTML =
      rows.map(([k, v]) => \`<div class="row"><span class="k">\${k}</span><span class="v">\${v}</span></div>\`).join('');
  } catch (e) {
    document.getElementById('content').innerHTML =
      '<div class="row"><span class="bad">无法获取状态</span></div>';
  }
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
refresh();
setInterval(refresh, ${PAGE_REFRESH_MS});
</script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
