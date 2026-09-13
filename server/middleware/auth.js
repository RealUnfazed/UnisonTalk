// This server is a pure JSON + WebSocket API now — the client is a fully
// separate static app — so every response here is JSON, including 401s.
// There's no server-side page to redirect to anymore; the client's
// controllers decide what to do when a request comes back unauthenticated.

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

module.exports = { requireAuth };
