// Gives the person a brand-new session ID at the moment they authenticate.
// Reusing the pre-login session ID would allow session fixation (an
// attacker plants a known ID, the victim logs in, the attacker now holds a
// logged-in session). Used by password login, registration and SSO login.
function establishSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

module.exports = { establishSession };
