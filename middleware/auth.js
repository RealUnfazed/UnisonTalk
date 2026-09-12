const User = require('../models/User');

// Blocks a route unless the session has a logged-in user.
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/login');
  }
  next();
}

// Sends logged-in users away from the auth pages.
function redirectIfAuthed(req, res, next) {
  if (req.session.userId) {
    return res.redirect('/chat');
  }
  next();
}

// Makes the current user available to every EJS view as `currentUser`,
// without forcing every route handler to fetch it manually.
async function loadCurrentUser(req, res, next) {
  res.locals.currentUser = null;
  if (req.session.userId) {
    try {
      // .select('-password') matters here: .lean() returns a plain object
      // straight from MongoDB, bypassing the User schema's toJSON transform
      // that normally strips the password hash.
      const user = await User.findById(req.session.userId).select('-password').lean();
      if (user) res.locals.currentUser = user;
    } catch (err) {
      console.error('[auth] failed to load current user:', err.message);
    }
  }
  next();
}

module.exports = { requireAuth, redirectIfAuthed, loadCurrentUser };
