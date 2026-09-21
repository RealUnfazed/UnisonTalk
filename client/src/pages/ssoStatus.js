import { api } from '../api.js';
import { $ } from '../utils/dom.js';

const SSO_ERROR_MESSAGES = {
  access_denied: 'You declined the Phasetime sign-in request.',
  missing_code: 'Phasetime sign-in did not complete correctly. Please try again.',
  state_mismatch: 'That sign-in link expired or was invalid. Please try again.',
  token_exchange_failed: 'Could not complete Phasetime sign-in. Please try again.',
  userinfo_failed: 'Could not fetch your Phasetime profile. Please try again.',
  invalid_profile: 'Phasetime did not return a valid profile. Please try again.',
  email_taken:
    'An account with this email already exists. Log in normally, then link your Phasetime account from the sidebar.',
  not_configured: 'Phasetime sign-in is not available on this server.',
};

// Shown on both login.html and register.html: reveals the "Continue with
// Phasetime" button only if the server actually has it configured (see
// server/config/phasetime.js) — otherwise it just stays hidden, no error,
// no broken link.
export async function revealSsoButtonIfEnabled() {
  const section = $('#sso-section');
  if (!section) return;
  try {
    const { enabled } = await api.get('/api/auth/sso/status');
    if (enabled) section.classList.remove('hidden');
  } catch {
    // Leave it hidden — same effect as "not configured".
  }
}

// Every Phasetime failure redirect lands on login.html?ssoError=<code>
// (see server/controllers/ssoController.js), regardless of whether the
// attempt started from the login or register page. Looked up against a
// fixed message table — never rendered from the raw query value — so a
// crafted link can't inject anything into the page.
export function showSsoErrorIfAny() {
  const errorEl = $('#form-error');
  if (!errorEl) return;
  const code = new URLSearchParams(window.location.search).get('ssoError');
  if (!code) return;

  errorEl.textContent = SSO_ERROR_MESSAGES[code] || 'Something went wrong during Phasetime sign-in. Please try again.';
  errorEl.classList.remove('hidden');
  window.history.replaceState({}, '', window.location.pathname);
}
