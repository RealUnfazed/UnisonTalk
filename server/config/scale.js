const logger = require('../utils/logger');

// Everything that lets more than one server instance cooperate. All of it is
// OPT-IN via REDIS_URL: unset, the app behaves exactly as a single process
// (in-memory rate limits, in-process Socket.IO), and `redis` is never loaded.
//
// With REDIS_URL set:
//   - the Socket.IO Redis adapter makes rooms and broadcasts cluster-wide,
//     so a message sent through instance A reaches sockets on instance B
//     (and io.in(room).socketsJoin/fetchSockets work across instances);
//   - rate-limit counters live in Redis (see middleware/rateLimit.js), so
//     the limits apply to the whole cluster, not per process.
//
// `deps` lets tests inject fakes instead of the real libraries.
async function connectRedis(env = process.env, deps = {}) {
  const url = env.REDIS_URL;
  if (!url) return null;

  const { createClient } = deps.redis || require('redis');
  const pub = createClient({ url });
  const sub = pub.duplicate();
  // node-redis throws on an 'error' event nobody listens to — which would
  // crash the whole server the first time Redis hiccups.
  for (const [name, client] of [['pub', pub], ['sub', sub]]) {
    client.on('error', (err) => logger.error(`[redis] ${name} client error:`, err.message));
  }
  await Promise.all([pub.connect(), sub.connect()]);
  logger.info('[redis] connected');

  return {
    pub,
    sub,
    ping: () => pub.ping(),
    close: () => Promise.allSettled([pub.quit(), sub.quit()]),
  };
}

function attachAdapter(io, redis, deps = {}) {
  if (!redis) return false;
  const { createAdapter } = deps.adapter || require('@socket.io/redis-adapter');
  io.adapter(createAdapter(redis.pub, redis.sub));
  logger.info('[redis] Socket.IO adapter attached — rooms and broadcasts now span all instances');
  return true;
}

module.exports = { connectRedis, attachAdapter };
