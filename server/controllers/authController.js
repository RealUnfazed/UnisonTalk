const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { serializeUser } = require('../utils/serialize');
const { establishSession } = require('../utils/session');

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const isString = (v) => typeof v === 'string';

// Compared against whenever the account doesn't exist (or has no password,
// i.e. SSO-only), so a login attempt takes about as long either way —
// otherwise response time would reveal which usernames are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

async function verifyPassword(user, password) {
  if (user && user.password && password.length <= 128) return user.comparePassword(password);
  await bcrypt.compare(password.slice(0, 128), DUMMY_HASH);
  return false;
}

async function register(req, res) {
  const { username, email, password } = req.body;
  if (![username, email, password].every(isString) || !username || !email || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  const cleanName = username.trim();
  const cleanEmail = email.trim().toLowerCase();

  if (!USERNAME_RE.test(cleanName)) {
    return res.status(400).json({ error: 'Username must be 3–24 characters: letters, numbers and underscores only.' });
  }
  if (cleanEmail.length > 254 || !EMAIL_RE.test(cleanEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (password.length > 128) return res.status(400).json({ error: 'Password is too long (128 characters max).' });

  const existing = await User.findOne({ $or: [{ username: cleanName }, { email: cleanEmail }] });
  if (existing) return res.status(409).json({ error: 'That username or email is already taken.' });

  let user;
  try {
    user = await User.create({ username: cleanName, email: cleanEmail, password });
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ error: 'That username or email is already taken.' });
    throw err;
  }
  await establishSession(req, user._id.toString());
  res.status(201).json({ user: serializeUser(user, user._id.toString()) });
}

async function login(req, res) {
  const { username, password } = req.body;
  if (!isString(username) || !isString(password)) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const user = await User.findOne({ username: username.trim() });
  const matches = await verifyPassword(user, password);
  if (!user || !matches) return res.status(401).json({ error: 'Invalid username or password.' });

  await establishSession(req, user._id.toString());
  res.json({ user: serializeUser(user, user._id.toString()) });
}

function logout(req, res) {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Could not log out.' });
    res.clearCookie('connect.sid');
    res.status(204).end();
  });
}

// Lets the client re-establish "am I logged in?" on page load.
async function me(req, res) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = await User.findById(req.session.userId).select('-password').lean();
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: serializeUser(user, req.session.userId) });
}

// Called lazily, the first time this browser needs a Secret Chat identity
// key — most accounts that never use Secret Chats will never call this.
async function updatePublicKey(req, res) {
  const { publicKey } = req.body;
  if (!isString(publicKey) || publicKey.length > 1024 || !KEY_RE.test(publicKey)) {
    return res.status(400).json({ error: 'publicKey (base64 SPKI) is required.' });
  }
  const user = await User.findByIdAndUpdate(req.session.userId, { publicKey }, { new: true }).select('-password');
  res.json({ user: serializeUser(user, req.session.userId) });
}

module.exports = { register, login, logout, me, updatePublicKey };
