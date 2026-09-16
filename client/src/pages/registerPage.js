import { api } from '../api.js';
import { $ } from '../utils/dom.js';

const form = $('#register-form');
const errorEl = $('#form-error');

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

// No key generation here — accounts start with Cloud Chats only, which
// need no keys at all. A Secret Chat identity is created lazily the first
// time this browser actually opens or starts one.
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.classList.add('hidden');

  const password = $('#password').value;
  const confirmPassword = $('#confirmPassword').value;
  if (password !== confirmPassword) {
    return showError('Passwords do not match.');
  }

  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    await api.post('/api/auth/register', {
      username: $('#username').value,
      email: $('#email').value,
      password,
    });
    window.location.href = '/';
  } catch (err) {
    showError(err.message);
    submitBtn.disabled = false;
  }
});
