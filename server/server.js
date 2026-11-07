require('dotenv').config();

const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const createApp = require('./app');
const initSockets = require('./sockets');
const { assertEncryptionKeyConfigured } = require('./utils/fieldCrypto');
const { validateEnv } = require('./config/validateEnv');
const { sweepOrphanUploads } = require('./utils/uploadCleanup');
const Message = require('./models/Message');
const User = require('./models/User');
const Chat = require('./models/Chat');

const PORT = process.env.PORT || 3000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Last-resort safety net: log and keep serving rather than letting one bad
// request kill the process. (Handlers are wrapped so this should be rare.)
process.on('unhandledRejection', (reason) => console.error('[server] unhandled rejection:', reason));

// Files uploaded but never attached to a message (abandoned compose, failed
// send, interrupted avatar change) are removed once they're a day old.
function scheduleUploadCleanup() {
  const uploads = path.join(__dirname, 'uploads');
  const run = async () => {
    try {
      const attachments = await sweepOrphanUploads({
        dir: uploads,
        olderThanMs: DAY_MS,
        isReferenced: (name) => Message.exists({ 'attachment.url': `/uploads/${name}` }),
      });
      const avatars = await sweepOrphanUploads({
        dir: path.join(uploads, 'avatars'),
        olderThanMs: DAY_MS,
        isReferenced: async (name) =>
          Boolean((await User.exists({ avatar: `/uploads/avatars/${name}` })) || (await Chat.exists({ avatar: `/uploads/avatars/${name}` }))),
      });
      const total = attachments.length + avatars.length;
      if (total) console.log(`[cleanup] removed ${total} orphaned upload(s)`);
    } catch (err) {
      console.error('[cleanup] failed:', err.message);
    }
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}

async function main() {
  const { errors, warnings } = validateEnv();
  warnings.forEach((w) => console.warn('[config]', w));
  if (errors.length) throw new Error(`Invalid configuration:\n - ${errors.join('\n - ')}`);

  // Fail loudly and immediately if Cloud Chat encryption isn't configured
  // — much better than the first chat message mysteriously erroring out.
  assertEncryptionKeyConfigured();

  await connectDB();

  const { app, sessionMiddleware } = createApp();
  const server = http.createServer(app);

  // Same CORS policy as the HTTP API (see app.js): explicit list, else any
  // origin in development and none in production.
  const allowedOrigins = process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
    : null;
  const io = new Server(server, {
    cors: { origin: allowedOrigins || process.env.NODE_ENV !== 'production', credentials: true },
  });

  initSockets(io, sessionMiddleware);
  app.set('io', io);
  scheduleUploadCleanup();

  server.listen(PORT, () => {
    console.log(`[server] UnisonTalk API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
