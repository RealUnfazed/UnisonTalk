require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const initSockets = require('./sockets');
const { loadCurrentUser } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');

const PORT = process.env.PORT || 3000;

async function main() {
  await connectDB();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // One session store shared by Express (via middleware) and Socket.IO
  // (via the wrap trick in sockets/index.js), so logging in once
  // authenticates both the page and the realtime connection.
  const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
      httpOnly: true,
    },
  });
  app.use(sessionMiddleware);
  app.use(loadCurrentUser);

  app.use(authRoutes);
  app.use(chatRoutes);

  // Multer surfaces file-too-large / bad-file-type errors here rather than
  // throwing synchronously, so they need their own handler to become JSON.
  app.use((err, req, res, next) => {
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    next(err);
  });

  app.use((req, res) => {
    res.status(404).render('404');
  });

  initSockets(io, sessionMiddleware);
  app.set('io', io);

  server.listen(PORT, () => {
    console.log(`[server] UnisonTalk listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
