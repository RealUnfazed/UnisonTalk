const express = require('express');
const { wrap } = require('../utils/asyncRoutes');
const authController = wrap(require('../controllers/authController'));
const ssoController = wrap(require('../controllers/ssoController'));
const rateLimit = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const TOO_MANY_LOGINS = 'Too many login attempts. Please wait a few minutes and try again.';
// Two layers: a tight limit per (IP + username) stops guessing one account's
// password; a looser per-IP limit stops one machine spraying many accounts.
// Successful logins don't count against either.
const loginPerAccount = rateLimit({
  name: 'login-account',
  windowMs: 15 * 60_000,
  max: 8,
  key: (req) => `${req.ip}:${String(req.body?.username ?? '').toLowerCase().slice(0, 64)}`,
  message: TOO_MANY_LOGINS,
  skipSuccessful: true,
});
const loginPerIp = rateLimit({ name: 'login-ip', windowMs: 15 * 60_000, max: 40, message: TOO_MANY_LOGINS, skipSuccessful: true });
const registerLimiter = rateLimit({ name: 'register', windowMs: 60 * 60_000, max: 10, message: 'Too many accounts created from this network. Please try again later.' });
const ssoLimiter = rateLimit({ name: 'sso', windowMs: 10 * 60_000, max: 30 });

router.post('/register', registerLimiter, authController.register);
router.post('/login', loginPerIp, loginPerAccount, authController.login);
router.post('/logout', authController.logout);
router.get('/me', authController.me);
router.post('/keys', requireAuth, authController.updatePublicKey);

// Phasetime SSO (https://github.com/RealUnfazed/Phasetime-SSO) — entirely
// optional; every one of these routes no-ops or 503s if it isn't
// configured (see server/config/phasetime.js). See README.md for setup.
router.get('/sso/status', ssoController.status);
router.get('/sso/phasetime', ssoLimiter, ssoController.startLogin);
router.get('/sso/phasetime/link', ssoLimiter, requireAuth, ssoController.startLink);
router.get('/sso/phasetime/callback', ssoLimiter, ssoController.handleCallback);
router.post('/sso/phasetime/unlink', requireAuth, ssoController.unlink);

module.exports = router;
