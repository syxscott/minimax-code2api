import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 8045,
  apiKeys: [],
  region: 'cn',
  upstreamBaseUrl: '',
  dataDir: '',
  defaultModel: 'MiniMax-M3',
  modelAlias: {},
  logLevel: 'info',
});

export const REGION_ORIGINS = Object.freeze({
  cn: 'https://agent.minimax.cn',
  io: 'https://agent.minimax.io',
});

export function loadConfig(configPath) {
  const fileConfig = readConfigFile(configPath);
  const merged = { ...DEFAULTS, ...fileConfig };

  if (process.env.HOST) merged.host = process.env.HOST;
  if (process.env.PORT) merged.port = Number.parseInt(process.env.PORT, 10) || merged.port;
  if (process.env.MINIMAX_REGION) merged.region = normalizeRegion(process.env.MINIMAX_REGION);
  if (process.env.MINIMAX_DATA_DIR) merged.dataDir = process.env.MINIMAX_DATA_DIR;
  if (process.env.UPSTREAM_BASE_URL) merged.upstreamBaseUrl = process.env.UPSTREAM_BASE_URL;
  if (process.env.API_KEYS) {
    merged.apiKeys = process.env.API_KEYS.split(',')
      .map((k) => k.trim())
      .filter(Boolean);
  }

  merged.region = normalizeRegion(merged.region);
  merged.port = Number.parseInt(merged.port, 10) || DEFAULTS.port;
  if (!Array.isArray(merged.apiKeys)) merged.apiKeys = [];
  if (typeof merged.modelAlias !== 'object' || merged.modelAlias === null) {
    merged.modelAlias = {};
  }
  merged.defaultModel = String(merged.defaultModel || DEFAULTS.defaultModel);
  return merged;
}

export function resolveConfigPath(explicit) {
  if (explicit) return path.resolve(explicit);
  return path.join(process.cwd(), 'config.json');
}

export function resolveDataDir(config) {
  if (config.dataDir && String(config.dataDir).trim()) {
    return path.resolve(String(config.dataDir).trim());
  }
  return path.join(os.homedir(), '.minimax');
}

export function resolveUpstreamOrigin(config) {
  const override = String(config.upstreamBaseUrl || '').trim().replace(/\/+$/u, '');
  if (override) {
    return new URL(override).origin;
  }
  return REGION_ORIGINS[config.region] ?? REGION_ORIGINS.cn;
}

// The managed preset base URL is ".../mavis/api/v1/llm/v1"; the desktop app
// normalizes it (strip trailing "/v1") before the Anthropic SDK appends
// "/v1/messages", so the effective upstream path is "/mavis/api/v1/llm/v1/messages".
export const MANAGED_BASE_PATH = '/mavis/api/v1/llm/v1';
export function anthropicMessagesUrl(config) {
  return `${resolveUpstreamOrigin(config)}${MANAGED_BASE_PATH}/messages`;
}
export function filesUploadUrl(config) {
  return `${resolveUpstreamOrigin(config)}${MANAGED_BASE_PATH}/files/upload`;
}

function readConfigFile(configPath) {
  if (!configPath) return {};
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Cannot read config file ${configPath}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Config file ${configPath} is not valid JSON: ${error.message}`);
  }
}

function normalizeRegion(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'global' || v === 'en' || v === 'io' || v === 'intl') return 'io';
  return 'cn';
}
