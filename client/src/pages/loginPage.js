import { api } from '../api.js';
import { $ } from '../utils/dom.js';

const form = $('#login-form');
const errorEl = $('#form-error');

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

// Deliberately simple: no key handling of any kind here. Cloud Chats need
// none, and a Secret Chat identity is generated lazily the first time this
// browser actually needs one (see ChatController.ensureIdentity). That's
// what keeps login itself fast, every time.
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.classList.add('hidden');

  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    await api.post('/api/auth/login', {
      username: $('#username').value,
      password: $('#password').value,
    });
    window.location.href = '/';
  } catch (err) {
    showError(err.message);
    submitBtn.disabled = false;
  }
});
