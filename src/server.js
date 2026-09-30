// minimax-code2api entrypoint: config, routing, auth, lifecycle.
import http from 'node:http';

import { loadConfig, resolveConfigPath } from './config.js';
import { createLogger } from './logger.js';
import { TokenManager } from './token-manager.js';
import { resolveDataDir } from './config.js';
import { handleMessages, handleCountTokens, handleFilesUpload, modelsPayload, respondUpstreamError } from './routes/anthropic.js';
import { handleChatCompletions, handleOpenAiModels } from './routes/openai.js';
import { handleDashboard, handleHealth, handleStatus } from './routes/admin.js';
import { sendJson, sendProtocolError, isAuthorized, readBody } from './http-utils.js';

function main() {
  const configPath = resolveConfigPath(process.argv[2] ?? process.env.MCODE2API_CONFIG);
  const config = loadConfig(configPath);
  const log = createLogger(config.logLevel);
  const dataDir = resolveDataDir(config);
  const tokenManager = new TokenManager(dataDir, log);
  const startedAt = Date.now();
  const stats = {
    anthropic: { requests: 0, errors: 0 },
    openai: { requests: 0, errors: 0 },
  };
  const ctx = { config, tokenManager, log, stats, startedAt, dataDir };

  const server = http.createServer(async (req, res) => {
    // Propagate client disconnects to the upstream request.
    const abortController = new AbortController();
    req.abortSignal = abortController.signal;
    req.on('close', () => {
      if (!res.writableEnded) abortController.abort(new Error('client closed connection'));
    });

    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    // CORS first: preflight OPTIONS never carries auth headers, and error
    // responses need the header too for browser clients to read them.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    try {
      if (route === 'GET /' || route === 'GET /index.html') {
        handleDashboard(res, ctx);
        return;
      }
      if (route === 'GET /health') {
        handleHealth(res);
        return;
      }

      // Everything below requires a proxy API key when one is configured.
      if (!isAuthorized(req, config)) {
        sendProtocolError(res, 401, 'authentication_error', 'invalid or missing API key');
        return;
      }

      switch (route) {
        case 'POST /v1/messages':
          await handleMessages(req, res, ctx);
          return;
        case 'POST /v1/messages/count_tokens':
          await handleCountTokens(req, res, ctx);
          return;
        case 'POST /v1/chat/completions':
          await handleChatCompletions(req, res, ctx);
          return;
        case 'GET /v1/models':
          sendJson(res, 200, modelsPayload());
          return;
        case 'GET /v1/status':
          await handleStatus(res, ctx);
          return;
        case 'POST /v1/files/upload':
          await handleFilesUpload(req, res, ctx);
          return;
        default:
          sendProtocolError(res, 404, 'not_found_error', `no route for ${route}`);
      }
    } catch (error) {
      log.error('unhandled error:', error);
      if (!res.writableEnded) {
        sendProtocolError(res, 500, 'api_error', `internal error: ${error.message}`);
      }
    }
  });

  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {}
  });

  server.once('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      log.error(`port ${config.port} is already in use. Change "port" in ${configPath} or set PORT.`);
      process.exitCode = 1;
      return;
    }
    log.error('server error:', error);
  });

  server.listen(config.port, config.host, () => {
    const display = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
    log.info(`minimax-code2api listening on http://${display}:${config.port}`);
    log.info(`  dashboard   http://${display}:${config.port}/`);
    log.info(`  anthropic   POST http://${display}:${config.port}/v1/messages`);
    log.info(`  openai      POST http://${display}:${config.port}/v1/chat/completions`);
    log.info(`  data dir    ${dataDir} (desktop broker must be running & logged in)`);
    log.info(
      config.apiKeys.length > 0
        ? `  auth        ${config.apiKeys.length} API key(s) configured`
        : '  auth        no API keys configured — anyone who can reach this port can use your plan',
    );
  });

  const shutdown = (signal) => {
    log.info(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
