const express = require('express');
const User = require('../models/User');
const { redirectIfAuthed } = require('../middleware/auth');

const router = express.Router();

router.get('/', (req, res) => res.redirect(req.session.userId ? '/chat' : '/login'));

router.get('/register', redirectIfAuthed, (req, res) => {
  res.render('auth/register', { error: null, values: {} });
});

router.post('/register', redirectIfAuthed, async (req, res) => {
  const { username, email, password, confirmPassword } = req.body;
  const values = { username, email };

  try {
    if (!username || !email || !password) {
      return res.render('auth/register', { error: 'All fields are required.', values });
    }
    if (password.length < 6) {
      return res.render('auth/register', {
        error: 'Password must be at least 6 characters.',
        values,
      });
    }
    if (password !== confirmPassword) {
      return res.render('auth/register', { error: 'Passwords do not match.', values });
    }

    const existing = await User.findOne({
      $or: [{ username: username.trim() }, { email: email.trim().toLowerCase() }],
    });
    if (existing) {
      return res.render('auth/register', {
        error: 'That username or email is already taken.',
        values,
      });
    }

    const user = await User.create({ username: username.trim(), email: email.trim(), password });
    req.session.userId = user._id.toString();
    res.redirect('/chat');
  } catch (err) {
    console.error('[auth] register failed:', err.message);
    res.render('auth/register', { error: 'Something went wrong. Please try again.', values });
  }
});

router.get('/login', redirectIfAuthed, (req, res) => {
  res.render('auth/login', { error: null, values: {} });
});

router.post('/login', redirectIfAuthed, async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username: (username || '').trim() });
    const matches = user ? await user.comparePassword(password || '') : false;

    if (!user || !matches) {
      return res.render('auth/login', {
        error: 'Invalid username or password.',
        values: { username },
      });
    }

    req.session.userId = user._id.toString();
    res.redirect('/chat');
  } catch (err) {
    console.error('[auth] login failed:', err.message);
    res.render('auth/login', { error: 'Something went wrong. Please try again.', values: {} });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
