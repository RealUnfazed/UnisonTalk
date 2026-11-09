const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../server/utils/logger');

const NOW = new Date('2026-11-08T10:00:00.000Z');
function capture(options = {}) {
  const lines = [];
  const logger = createLogger({ format: 'json', level: 'debug', now: () => NOW, write: (level, line) => lines.push({ level, line }), ...options });
  return { logger, lines, last: () => JSON.parse(lines[lines.length - 1].line) };
}

describe('logger', () => {
  describe('levels', () => {
    it('drops everything below the configured level', () => {
      const { logger, lines } = capture({ level: 'warn' });
      logger.debug('d'); logger.info('i'); logger.warn('w'); logger.error('e');
      assert.deepEqual(lines.map((l) => l.level), ['warn', 'error']);
    });

    it('"silent" drops everything, "debug" keeps everything', () => {
      const silent = capture({ level: 'silent' });
      ['debug', 'info', 'warn', 'error'].forEach((l) => silent.logger[l]('x'));
      assert.equal(silent.lines.length, 0);
      const loud = capture({ level: 'debug' });
      ['debug', 'info', 'warn', 'error'].forEach((l) => loud.logger[l]('x'));
      assert.equal(loud.lines.length, 4);
    });

    it('reads LOG_LEVEL at call time, so dotenv and tests can set it late', () => {
      const saved = process.env.LOG_LEVEL;
      try {
        const { logger, lines } = capture({ level: undefined });
        process.env.LOG_LEVEL = 'error';
        logger.info('hidden'); logger.error('shown');
        assert.equal(lines.length, 1);
      } finally {
        if (saved === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = saved;
      }
    });
  });

  describe('output', () => {
    it('writes one JSON object per line with level, time and msg', () => {
      const { logger, last } = capture();
      logger.info('[server] listening', { port: 3000 });
      assert.deepEqual(last(), { level: 'info', time: NOW.toISOString(), msg: '[server] listening', port: 3000 });
    });

    it('has a readable pretty format', () => {
      const { logger, lines } = capture({ format: 'pretty' });
      logger.warn('careful', { id: 7 });
      assert.equal(lines[0].line, `${NOW.toISOString()} WARN  careful {"id":7}`);
    });

    it('accepts console-style arguments', () => {
      const { logger, last } = capture();
      logger.error('[chat] failed:', 'boom', 42, undefined);
      assert.equal(last().msg, '[chat] failed: boom 42');
    });

    it('serialises Errors (message, name, code, stack) instead of printing {}', () => {
      const { logger, last } = capture();
      const err = Object.assign(new Error('db down'), { code: 'E_DB' });
      logger.error('[x] failed', err);
      assert.equal(last().err.message, 'db down');
      assert.equal(last().err.code, 'E_DB');
      assert.match(last().err.stack, /db down/);
      logger.error(err); // an Error alone still produces a message
      assert.equal(last().msg, 'db down');
    });

    it('lets nobody forge the core fields', () => {
      const { logger, last } = capture();
      logger.info('real', { level: 'debug', msg: 'forged', time: 'yesterday' });
      assert.equal(last().level, 'info');
      assert.equal(last().msg, 'real');
      assert.equal(last().time, NOW.toISOString());
    });
  });

  describe('safety', () => {
    it('redacts anything under a sensitive-looking key, at any depth', () => {
      const { logger, lines, last } = capture();
      logger.info('login', {
        user: { name: 'ok', password: 'hunter2', profile: { apiKey: 'AKIA...', token: 'tok', note: 'fine' } },
        headers: { cookie: 'connect.sid=abc', authorization: 'Bearer xyz' },
        CLOUD_ENCRYPTION_KEY: 'deadbeef',
        SESSION_SECRET: 'shh',
      });
      const out = last();
      assert.equal(out.user.name, 'ok');
      assert.equal(out.user.profile.note, 'fine');
      for (const v of [out.user.password, out.user.profile.apiKey, out.user.profile.token, out.headers.cookie, out.headers.authorization, out.CLOUD_ENCRYPTION_KEY, out.SESSION_SECRET]) {
        assert.equal(v, '[redacted]');
      }
      for (const secret of ['hunter2', 'AKIA', 'connect.sid=abc', 'Bearer xyz', 'deadbeef', 'shh']) {
        assert.ok(!lines[0].line.includes(secret), `leaked ${secret}`);
      }
    });

    it('bounds size and survives cycles', () => {
      const { logger, last } = capture();
      const cyclic = { name: 'loop' };
      cyclic.self = cyclic;
      logger.info('big', { long: 'x'.repeat(5000), list: Array.from({ length: 100 }, (_, i) => i), deep: { a: { b: { c: { d: { e: 1 } } } } }, cyclic });
      const out = last();
      assert.ok(out.long.length <= 2001);
      assert.equal(out.list.length, 20);
      assert.equal(typeof out.deep.a.b, 'object');
      assert.equal(out.deep.a.b.c, '[object]', 'nesting beyond 4 levels collapses');
      assert.equal(out.cyclic.self, '[circular]');
    });
  });

  describe('child loggers', () => {
    it('add their bindings to every line, and nest', () => {
      const { logger, last } = capture();
      logger.child({ requestId: 'r1' }).child({ userId: 'u1' }).info('hi', { extra: true });
      assert.deepEqual(last(), { level: 'info', time: NOW.toISOString(), msg: 'hi', extra: true, requestId: 'r1', userId: 'u1' });
    });

    it('redact secrets in bindings too', () => {
      const { logger, last } = capture();
      logger.child({ password: 'p', ok: 1 }).info('x');
      assert.equal(last().password, '[redacted]');
      assert.equal(last().ok, 1);
    });
  });
});
