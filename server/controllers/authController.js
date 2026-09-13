const User = require('../models/User');
const { serializeUser } = require('../utils/serialize');

async function register(req, res) {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const existing = await User.findOne({
      $or: [{ username: username.trim() }, { email: email.trim().toLowerCase() }],
    });
    if (existing) {
      return res.status(409).json({ error: 'That username or email is already taken.' });
    }

    const user = await User.create({ username: username.trim(), email: email.trim(), password });
    req.session.userId = user._id.toString();
    res.status(201).json({ user: serializeUser(user) });
  } catch (err) {
    console.error('[auth] register failed:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

async function login(req, res) {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: (username || '').trim() });
    const matches = user ? await user.comparePassword(password || '') : false;

    if (!user || !matches) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    req.session.userId = user._id.toString();
    res.json({ user: serializeUser(user) });
  } catch (err) {
    console.error('[auth] login failed:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

function logout(req, res) {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Could not log out.' });
    res.clearCookie('connect.sid');
    res.status(204).end();
  });
}

// Lets the client re-establish "am I logged in?" on page load without
// needing to store anything itself beyond the session cookie.
async function me(req, res) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = await User.findById(req.session.userId).select('-password').lean();
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: serializeUser(user) });
}

// The client calls this right after generating (or loading) its ECDH
// identity key pair, uploading only the public half. The server has no
// way to derive, guess, or reconstruct the private key from this.
async function updatePublicKey(req, res) {
  const { publicKey } = req.body;
  if (!publicKey || typeof publicKey !== 'string') {
    return res.status(400).json({ error: 'publicKey (base64 SPKI) is required.' });
  }
  const user = await User.findByIdAndUpdate(
    req.session.userId,
    { publicKey },
    { new: true }
  ).select('-password');
  res.json({ user: serializeUser(user) });
}

module.exports = { register, login, logout, me, updatePublicKey };
