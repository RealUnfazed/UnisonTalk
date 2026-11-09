require('dotenv').config();

const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const logger = require('./utils/logger');
const connectDB = require('./config/db');
const createApp = require('./app');
const initSockets = require('./sockets');
const rateLimit = require('./middleware/rateLimit');
const { connectRedis, attachAdapter } = require('./config/scale');
const { assertEncryptionKeyConfigured } = require('./utils/fieldCrypto');
const { validateEnv } = require('./config/validateEnv');
const { UPLOADS_DIR, AVATARS_DIR, ensureUploadDirs } = require('./config/paths');
const { sweepOrphanUploads } = require('./utils/uploadCleanup');
const { createShutdown, installSignalHandlers } = require('./utils/shutdown');
const Message = require('./models/Message');
const User = require('./models/User');
const Chat = require('./models/Chat');

const PORT = process.env.PORT || 3000;
const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Last-resort safety net: log and keep serving rather than letting one bad
// request kill the process. (Handlers are wrapped so this should be rare.)
process.on('unhandledRejection', (reason) => logger.error('[server] unhandled rejection:', reason));

// Files uploaded but never attached to a message (abandoned compose, failed
// send, interrupted avatar change) are removed once they're a day old.
function scheduleUploadCleanup() {
  const run = async () => {
    try {
      const attachments = await sweepOrphanUploads({
        dir: UPLOADS_DIR,
        olderThanMs: DAY_MS,
        isReferenced: (name) => Message.exists({ 'attachment.url': `/uploads/${name}` }),
      });
      const avatars = await sweepOrphanUploads({
        dir: AVATARS_DIR,
        olderThanMs: DAY_MS,
        isReferenced: async (name) =>
          Boolean((await User.exists({ avatar: `/uploads/avatars/${name}` })) || (await Chat.exists({ avatar: `/uploads/avatars/${name}` }))),
      });
      const total = attachments.length + avatars.length;
      if (total) logger.info(`[cleanup] removed ${total} orphaned upload(s)`);
    } catch (err) {
      logger.error('[cleanup] failed:', err.message);
    }
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}

async function main() {
  const { errors, warnings } = validateEnv();
  warnings.forEach((w) => logger.warn('[config]', w));
  if (errors.length) throw new Error(`Invalid configuration:\n - ${errors.join('\n - ')}`);

  // Fail loudly and immediately if Cloud Chat encryption isn't configured
  // — much better than the first chat message mysteriously erroring out.
  assertEncryptionKeyConfigured();
  ensureUploadDirs(); // a freshly mounted volume is empty

  await connectDB();

  // Optional: with REDIS_URL, several instances share Socket.IO rooms and
  // rate-limit counters. Without it everything stays in-process.
  const redis = await connectRedis();
  if (redis) rateLimit.setDefaultStore(new rateLimit.RedisStore({ client: redis.pub }));

  const { app, sessionMiddleware, sessionStore } = createApp();
  if (redis) app.locals.readinessChecks.push({ name: 'redis', check: () => redis.ping() });

  const server = http.createServer(app);

  // Same CORS policy as the HTTP API (see app.js): explicit list, else any
  // origin in development and none in production.
  const allowedOrigins = process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
    : null;
  const transports = process.env.SOCKET_TRANSPORTS
    ? process.env.SOCKET_TRANSPORTS.split(',').map((t) => t.trim()).filter(Boolean)
    : undefined; // Socket.IO's default: long-polling first, then upgrade
  const io = new Server(server, {
    cors: { origin: allowedOrigins || process.env.NODE_ENV !== 'production', credentials: true },
    ...(transports && { transports }),
  });

  attachAdapter(io, redis);
  const { presence } = initSockets(io, sessionMiddleware);
  app.set('io', io);
  scheduleUploadCleanup();

  // Graceful shutdown (docker stop / Kubernetes / Ctrl-C): fail readiness so
  // the load balancer stops sending traffic, drop this instance's sockets,
  // settle presence for whoever was on them, then close everything cleanly.
  const shutdown = createShutdown({
    timeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 15_000),
    steps: [
      { name: 'fail readiness', run: async () => { app.locals.shuttingDown = true; await sleep(Number(process.env.SHUTDOWN_DRAIN_MS ?? 0)); } },
      // `io.local`: only THIS instance's sockets — other instances keep theirs.
      { name: "disconnect this instance's sockets", run: async () => { io.local.disconnectSockets(true); await sleep(150); } },
      { name: 'settle presence', run: () => presence.flush() },
      { name: 'close HTTP + Socket.IO', run: () => new Promise((resolve) => io.close(resolve)) },
      { name: 'close Redis', run: async () => { if (redis) await redis.close(); } },
      { name: 'close session store', run: () => sessionStore.close() },
      { name: 'close MongoDB', run: () => mongoose.disconnect() },
    ],
  });
  installSignalHandlers(shutdown);

  server.listen(PORT, () => {
    logger.info(`[server] UnisonTalk listening on http://localhost:${PORT}`, {
      port: Number(PORT),
      env: process.env.NODE_ENV || 'development',
      redis: Boolean(redis),
    });
  });
}

main().catch((err) => {
  logger.error('[server] failed to start:', err);
  process.exit(1);
});
