require('dotenv').config();

const http = require('http');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const createApp = require('./app');
const initSockets = require('./sockets');

const PORT = process.env.PORT || 3000;

async function main() {
  await connectDB();

  const { app, sessionMiddleware } = createApp();
  const server = http.createServer(app);

  const io = new Server(server, {
    cors: {
      origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',') : true,
      credentials: true,
    },
  });

  initSockets(io, sessionMiddleware);
  app.set('io', io);

  server.listen(PORT, () => {
    console.log(`[server] UnisonTalk API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
