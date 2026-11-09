// A small structured logger — a drop-in for console.* that adds levels,
// JSON output for log aggregators, secret redaction and request-scoped
// child loggers. No dependencies.
//
//   LOG_LEVEL   debug | info (default) | warn | error | silent
//   LOG_FORMAT  json (default in production) | pretty (default otherwise)
//
//   logger.info('[server] listening', { port: 3000 });
//   logger.error('[chat] failed:', err);               // Errors are serialised (message, stack, code)
//   const log = logger.child({ requestId });            // adds fields to every line
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

// Anything under a key that looks like this is replaced, at any depth, so a
// careless `logger.info('login', req.body)` can't write a password to disk.
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential|private[-_]?key|encryption[-_]?key/i;
const MAX_DEPTH = 4;
const MAX_STRING = 2000;
const MAX_ITEMS = 20;

function serializeError(err) {
  return { name: err.name, message: err.message, code: err.code, stack: err.stack };
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (value instanceof Error) return serializeError(value);
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[object]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => sanitize(item, depth + 1, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : sanitize(v, depth + 1, seen);
  }
  return out;
}

// console-style arguments -> { msg, fields }: strings form the message,
// Errors go to `err`, plain objects are merged in as fields.
function splitArgs(args) {
  const parts = [];
  const fields = {};
  for (const arg of args) {
    if (arg instanceof Error) {
      if (!parts.length) parts.push(arg.message);
      fields.err = serializeError(arg);
    } else if (arg && typeof arg === 'object') {
      Object.assign(fields, sanitize(arg));
    } else if (arg !== undefined) {
      parts.push(typeof arg === 'string' ? arg : String(arg));
    }
  }
  return { msg: parts.join(' '), fields };
}

function createLogger({ level, format, write, bindings = {}, now = () => new Date() } = {}) {
  // Resolved on every call (not at import) so dotenv and tests can set env late.
  const currentLevel = () => LEVELS[level ?? process.env.LOG_LEVEL ?? 'info'] ?? LEVELS.info;
  const currentFormat = () => format ?? process.env.LOG_FORMAT ?? (process.env.NODE_ENV === 'production' ? 'json' : 'pretty');
  const sink = write || ((lvl, line) => (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`));

  function log(lvl, args) {
    if (LEVELS[lvl] < currentLevel()) return;
    const { msg, fields } = splitArgs(args);
    // Core keys are spread last so a field named "level" or "msg" can't forge them.
    const record = { ...fields, ...bindings, level: lvl, time: now().toISOString(), msg };
    if (currentFormat() === 'json') return sink(lvl, JSON.stringify(record));

    const { level: _l, time, msg: _m, ...rest } = record;
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    sink(lvl, `${time} ${lvl.toUpperCase().padEnd(5)} ${msg}${extra}`);
  }

  const logger = {
    child: (extra) => createLogger({ level, format, write, now, bindings: { ...bindings, ...sanitize(extra) } }),
  };
  for (const lvl of ['debug', 'info', 'warn', 'error']) logger[lvl] = (...args) => log(lvl, args);
  return logger;
}

module.exports = createLogger();
module.exports.createLogger = createLogger;
module.exports.sanitize = sanitize;
module.exports.serializeError = serializeError;
