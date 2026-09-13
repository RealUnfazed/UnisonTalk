import { api } from '../api.js';
import { $ } from '../utils/dom.js';
import { getOrCreateIdentity } from '../crypto/identity.js';

const form = $('#login-form');
const errorEl = $('#form-error');

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.classList.add('hidden');

  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    const { user } = await api.post('/api/auth/login', {
      username: $('#username').value,
      password: $('#password').value,
    });

    // Make sure this browser has (or generates) this account's identity
    // key pair before entering the app — everything else assumes it exists.
    const { publicKeyB64, isNewDevice } = await getOrCreateIdentity(user.id, user.publicKey);

    if (isNewDevice) {
      const proceed = confirm(
        "This browser doesn't have your encryption key from a previous device.\n\n" +
          "Continuing will set up a new key here. You won't be able to decrypt group chats " +
          'that were created before this point (private chats are unaffected). Continue?'
      );
      if (!proceed) {
        submitBtn.disabled = false;
        return;
      }
    }

    if (publicKeyB64 !== user.publicKey) {
      await api.post('/api/auth/keys', { publicKey: publicKeyB64 });
    }

    window.location.href = '/';
  } catch (err) {
    showError(err.message);
    submitBtn.disabled = false;
  }
});
