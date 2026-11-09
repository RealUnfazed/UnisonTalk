// Fail fast on configuration that would silently weaken security.
function validateEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const prod = env.NODE_ENV === 'production';
  const secret = env.SESSION_SECRET || '';
  const placeholder = /replace_this/i.test(secret);

  if (!secret) errors.push('SESSION_SECRET is not set.');
  else if (prod && (secret.length < 32 || placeholder)) {
    errors.push('SESSION_SECRET must be a random string of at least 32 characters in production (not the .env.example placeholder).');
  } else if (placeholder) {
    warnings.push('SESSION_SECRET is still the placeholder from .env.example.');
  }
  if (prod && !env.ALLOWED_ORIGIN) {
    warnings.push('ALLOWED_ORIGIN is not set: cross-origin requests are refused (correct if this server also serves the client).');
  }
  if (prod && !env.TRUST_PROXY) {
    warnings.push('TRUST_PROXY is not set. Behind a TLS-terminating proxy, secure cookies and per-IP rate limiting need it.');
  }
  if (env.REDIS_URL && !/^rediss?:\/\//.test(env.REDIS_URL)) {
    errors.push('REDIS_URL must start with redis:// or rediss:// (TLS).');
  }
  if (env.LOG_LEVEL && !['debug', 'info', 'warn', 'error', 'silent'].includes(env.LOG_LEVEL)) {
    warnings.push(`LOG_LEVEL "${env.LOG_LEVEL}" is not one of debug, info, warn, error, silent — using info.`);
  }
  return { errors, warnings };
}

module.exports = { validateEnv };
