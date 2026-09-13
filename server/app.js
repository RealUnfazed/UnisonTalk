const path = require('path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const MongoStore = require('connect-mongo');

const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');

function createApp() {
  const app = express();

  // CORS is what makes "separated client and server" actually mean
  // something: by default this reflects whatever origin made the request
  // (so the client works whether it's served by this same process, from a
  // different port during development, or from a completely different
  // host/CDN in production), while still allowing cookies to flow via
  // `credentials: true`. Lock this down to a real origin list via
  // ALLOWED_ORIGIN before deploying publicly.
  app.use(
    cors({
      origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',') : true,
      credentials: true,
    })
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
      httpOnly: true,
      sameSite: 'lax', // switch to 'none' + secure:true if client and server are ever on different sites in production
    },
  });
  app.use(sessionMiddleware);

  // --- API routes -----------------------------------------------------
  // This server has no view layer at all now — every response below is
  // JSON. The "V" in MVC lives entirely in client/src/views.
  app.use('/api/auth', authRoutes);
  app.use('/api', chatRoutes);

  // Encrypted attachment blobs. Safe to serve as plain static files: what's
  // on disk is AES-GCM ciphertext, meaningless without the key that only
  // chat participants hold client-side.
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

  // --- Static client ----------------------------------------------------
  // Convenience for local development: this same process can serve the
  // client too, so `npm run dev` "just works" with one command. Nothing
  // about the client depends on this though — point client/src/config.js
  // at a different API_BASE_URL and host client/ anywhere (Netlify, S3,
  // a separate dev server) if you want true process-level separation.
  app.use(express.static(path.join(__dirname, '..', 'client', 'public')));
  app.use('/src', express.static(path.join(__dirname, '..', 'client', 'src')));

  // Multer surfaces file-too-large errors here rather than throwing
  // synchronously, so they need their own handler to become JSON.
  app.use((err, req, res, next) => {
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(400).json({ error: err.message || 'Request failed' });
    }
    next(err);
  });

  app.use((req, res) => {
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.status(404).sendFile(path.join(__dirname, '..', 'client', 'public', '404.html'));
  });

  return { app, sessionMiddleware };
}

module.exports = createApp;
