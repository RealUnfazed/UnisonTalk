// Boots the REAL Express app against a throwaway in-memory MongoDB, so
// integration tests exercise actual routes, middleware, models and indexes —
// not mocks. (mongodb-memory-server downloads a mongod binary on first run.)
const crypto = require('node:crypto');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const User = require('../../server/models/User');
const Chat = require('../../server/models/Chat');
const Message = require('../../server/models/Message');

const PASSWORD = 'secret123';

async function startTestApp() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('unisontalk_test');
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.CLOUD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  for (const k of ['PHASETIME_SSO_BASE_URL', 'PHASETIME_CLIENT_ID', 'PHASETIME_CLIENT_SECRET', 'PHASETIME_REDIRECT_URI']) {
    delete process.env[k];
  }

  await mongoose.connect(process.env.MONGODB_URI);
  await User.init(); // wait for indexes (incl. the phasetimeId partial index) to exist

  const { app, sessionStore } = require('../../server/app')();
  // Controllers push real-time updates through Socket.IO; tests don't need a socket server.
  app.set('io', { to: () => ({ emit() {} }), in: () => ({ socketsJoin() {} }) });

  return {
    app,
    async stop() {
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

const resetDb = () => Promise.all([User.deleteMany({}), Chat.deleteMany({}), Message.deleteMany({})]);

module.exports = { startTestApp, makeUser, loginAs, resetDb, PASSWORD };
