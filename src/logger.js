// Simple leveled logger. Tokens and other credentials are always redacted.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_RE =
  /(eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}|Bearer\s+\S+|"accessToken"\s*:\s*"[^"]+")/g;

export function redact(value) {
  if (typeof value === 'string') {
    return value.replace(REDACT_RE, (m) => `${m.slice(0, 12)}…[redacted]`);
  }
  if (value instanceof Error) {
    return `${value.name}: ${redact(String(value.message ?? ''))}`;
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return redact(JSON.stringify(value));
    } catch {
      return '[unserializable]';
    }
  }
  return String(value);
}

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (stream, tag, args) => {
    const parts = args.map((a) => (typeof a === 'string' ? redact(a) : redact(a)));
    stream.write(`${new Date().toISOString()} [${tag}] ${parts.join(' ')}\n`);
  };
  return {
    debug: (...a) => threshold <= LEVELS.debug && write(process.stderr, 'debug', a),
    info: (...a) => threshold <= LEVELS.info && write(process.stderr, 'info', a),
    warn: (...a) => threshold <= LEVELS.warn && write(process.stderr, 'warn', a),
    error: (...a) => threshold <= LEVELS.error && write(process.stderr, 'error', a),
  };
}
