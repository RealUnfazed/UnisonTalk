const express = require('express');
const authController = require('../controllers/authController');
const ssoController = require('../controllers/ssoController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.get('/me', authController.me);
router.post('/keys', requireAuth, authController.updatePublicKey);

// Phasetime SSO (https://github.com/RealUnfazed/Phasetime-SSO) — entirely
// optional; every one of these routes no-ops or 503s if it isn't
// configured (see server/config/phasetime.js). See README.md for setup.
router.get('/sso/status', ssoController.status);
router.get('/sso/phasetime', ssoController.startLogin);
router.get('/sso/phasetime/link', requireAuth, ssoController.startLink);
router.get('/sso/phasetime/callback', ssoController.handleCallback);
router.post('/sso/phasetime/unlink', requireAuth, ssoController.unlink);

module.exports = router;
