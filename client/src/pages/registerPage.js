import { api } from '../api.js';
import { $ } from '../utils/dom.js';
import { getOrCreateIdentity } from '../crypto/identity.js';

const form = $('#register-form');
const errorEl = $('#form-error');

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

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
    const { user } = await api.post('/api/auth/register', {
      username: $('#username').value,
      email: $('#email').value,
      password,
    });

    // Brand-new account: this is always a fresh identity key, generated
    // right here and never sent to the server in any form.
    const { publicKeyB64 } = await getOrCreateIdentity(user.id, user.publicKey);
    await api.post('/api/auth/keys', { publicKey: publicKeyB64 });

    window.location.href = '/';
  } catch (err) {
    showError(err.message);
    submitBtn.disabled = false;
  }
});
