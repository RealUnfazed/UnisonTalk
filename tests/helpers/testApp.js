// Boots the REAL Express app against a throwaway in-memory MongoDB, so
// integration tests exercise actual routes, middleware, models and indexes —
// not mocks. (mongodb-memory-server downloads a mongod binary on first run.)
//
// { sockets: true } also starts a real Socket.IO server on a random port so
// tests can drive the live message path with socket.io-client. Without it,
// controllers get a stub `io` that records what they would have broadcast
// into `emitted` — enough to assert "the room was told about the edit".
const crypto = require('node:crypto');
const http = require('node:http');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const User = require('../../server/models/User');
const Chat = require('../../server/models/Chat');
const Message = require('../../server/models/Message');

const PASSWORD = 'secret123';

async function startTestApp({ sockets = false, presenceGraceMs = 50 } = {}) {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('unisontalk_test');
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.RATE_LIMIT_DISABLED = 'true'; // individual tests opt back in
  process.env.LOG_LEVEL = 'silent'; // the suite deliberately provokes errors; keep output readable
  process.env.PRESENCE_GRACE_MS = String(presenceGraceMs); // production default is 3000
  process.env.CLOUD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  for (const k of ['PHASETIME_SSO_BASE_URL', 'PHASETIME_CLIENT_ID', 'PHASETIME_CLIENT_SECRET', 'PHASETIME_REDIRECT_URI']) {
    delete process.env[k];
  }

  await mongoose.connect(process.env.MONGODB_URI);
  await User.init(); // wait for indexes (incl. the phasetimeId partial index) to exist

  const { app, sessionMiddleware, sessionStore } = require('../../server/app')();
  const emitted = [];
  let io = null;
  let url = null;

  if (sockets) {
    const { Server } = require('socket.io');
    const initSockets = require('../../server/sockets');
    const server = http.createServer(app);
    io = new Server(server);
    initSockets(io, sessionMiddleware);
    app.set('io', io);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  } else {
    app.set('io', {
      to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
      in: () => ({ socketsJoin() {}, socketsLeave() {} }),
    });
  }

  return {
    app,
    url,
    emitted,
    async stop() {
      if (io) await new Promise((resolve) => io.close(resolve)); // also closes the HTTP server
      await sessionStore.close();
      await mongoose.disconnect();
      await mongod.stop();
    },
  };
}

const makeUser = (username, extra = {}) =>
  User.create({ username, email: `${username}@example.com`, password: PASSWORD, ...extra });

async function loginAs(app, username) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ username, password: PASSWORD }).expect(200);
  return agent;
}

// The session cookie a browser would send — for authenticating a socket.
async function loginCookie(app, username) {
  const res = await request(app).post('/api/auth/login').send({ username, password: PASSWORD }).expect(200);
  return res.headers['set-cookie'].find((c) => c.startsWith('connect.sid')).split(';')[0];
}

const resetDb = () => Promise.all([User.deleteMany({}), Chat.deleteMany({}), Message.deleteMany({})]);

module.exports = { startTestApp, makeUser, loginAs, loginCookie, resetDb, PASSWORD };
