const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const session = require('express-session');
const MongoStore = require('connect-mongo');

const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');
const { securityHeaders } = require('./middleware/securityHeaders');
const rateLimit = require('./middleware/rateLimit');
const { requireAuth } = require('./middleware/auth');
const { wrap } = require('./utils/asyncRoutes');
const { serveAttachment } = wrap(require('./controllers/uploadController'));

const UPLOADS_DIR = path.join(__dirname, 'uploads');

// "1" / "2" = number of proxy hops, "true" = trust all, or a subnet name
// like "loopback". Needed behind nginx/Render/Fly/etc. so req.ip, secure
// cookies and rate limiting see the real client — and must NOT be set
// when there's no proxy, or clients could spoof their IP via X-Forwarded-For.
function parseTrustProxy(value) {
  if (!value) return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function createApp() {
  const app = express();
  const isProd = process.env.NODE_ENV === 'production';

  app.disable('x-powered-by');
  app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
  app.use(securityHeaders);

  // CORS: with ALLOWED_ORIGIN set, only those origins may call the API with
  // cookies. Unset, development reflects any origin (convenient for running
  // the client on another port) but production allows none — same-origin
  // only, which is correct whenever this server also serves the client.
  const allowedOrigins = process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
    : null;
  app.use(cors({ origin: allowedOrigins || !isProd, credentials: true }));

  app.use(express.json()); // JSON only (100kb cap) — no urlencoded forms are accepted

  const sessionStore = MongoStore.create({ mongoUrl: process.env.MONGODB_URI });
  const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
      httpOnly: true,
      sameSite: 'lax',
      // Secure in production (needs TRUST_PROXY behind a TLS-terminating
      // proxy). COOKIE_SECURE=false is the escape hatch for plain-HTTP
      // production-mode testing.
      secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd,
    },
  });
  app.use(sessionMiddleware);

  // --- API ----------------------------------------------------------------
  app.use('/api', rateLimit({ windowMs: 60_000, max: 600 }));
  app.use('/api/auth', authRoutes);
  app.use('/api', chatRoutes);

  // --- Uploads --------------------------------------------------------------
  // Avatars are public (they're shown to other people), and their file
  // extension comes from a validated image type, never from the upload's name.
  app.use('/uploads/avatars', express.static(path.join(UPLOADS_DIR, 'avatars'), { index: false, dotfiles: 'deny', maxAge: '1d' }));
  // Chat attachments are NOT served statically: you must be logged in AND a
  // member of a chat that contains the file. See controllers/uploadController.js.
  app.get('/uploads/:filename', requireAuth, serveAttachment);

  // --- Static client ----------------------------------------------------------
  // Convenience for local development: this same process can serve the
  // client too. Nothing about the client depends on that — point
  // client/src/config.js at a different API_BASE_URL to host it elsewhere.
  app.use(express.static(path.join(__dirname, '..', 'client', 'public')));
  app.use('/src', express.static(path.join(__dirname, '..', 'client', 'src')));

  app.use((req, res) => {
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.status(404).sendFile(path.join(__dirname, '..', 'client', 'public', '404.html'));
  });

  // Last stop for every error. Deliberate client errors (bad JSON, rejected
  // uploads — anything carrying a 4xx status) get a safe message; anything
  // else is logged server-side and answered with a generic 500, so internals
  // (stack traces, DB messages) never reach the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode;
    let message = err.message;

    if (err.type === 'entity.parse.failed') message = 'Invalid request body.';
    else if (err.type === 'entity.too.large') message = 'Request body is too large.';
    else if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : 'Upload failed.';
    }

    if (!(status >= 400 && status < 500)) {
      console.error(`[server] error handling ${req.method} ${req.originalUrl}:`, err);
      status = 500;
      message = 'Something went wrong. Please try again.';
    }
    if (res.headersSent) return;
    res.status(status).json({ error: message });
  });

  return { app, sessionMiddleware, sessionStore };
}

module.exports = createApp;
