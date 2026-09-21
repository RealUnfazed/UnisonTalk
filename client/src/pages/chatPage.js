import { api } from '../api.js';
import { $ } from '../utils/dom.js';
import { connectSocket } from '../socket.js';
import { AppState } from '../models/AppState.js';
import { SidebarView } from '../views/SidebarView.js';
import { ChatView } from '../views/ChatView.js';
import { ModalView } from '../views/ModalView.js';
import { ChatController } from '../controllers/ChatController.js';

const SSO_LINK_ERROR_MESSAGES = {
  already_linked_elsewhere: 'That Phasetime account is already linked to a different UnisonTalk account.',
  not_configured: 'Phasetime sign-in is not available on this server.',
};

// No encryption setup happens here at all — Cloud Chats (the default)
// need no keys, and Secret Chat identity is created lazily, only the
// first time the person actually opens or starts one (see
// ChatController.ensureIdentity). That's what keeps a normal login fast
// and simple: session check, load chats, done.
async function bootstrap() {
  // Every page load re-confirms the session with the server — there's no
  // client-side "am I logged in" state to trust on its own.
  let user;
  try {
    ({ user } = await api.get('/api/auth/me'));
  } catch {
    window.location.href = '/login.html';
    return;
  }

  const state = new AppState();
  state.setCurrentUser(user);

  const chats = await api.get('/api/chats');
  state.setChats(chats);

  const sidebarView = new SidebarView({ onSelectChat: (chatId) => controller.openChat(chatId) });
  sidebarView.renderMe(user);

  const chatView = new ChatView();
  const modalView = new ModalView();
  const socket = connectSocket();

  const controller = new ChatController({ state, sidebarView, chatView, modalView, socket });

  controller.renderSidebar();

  $('#logout-btn').addEventListener('click', async () => {
    try {
      await api.post('/api/auth/logout', {});
    } finally {
      window.location.href = '/login.html';
    }
  });

  setupPhasetimeButton(state);
  showSsoLinkResultIfAny();
}

// Shows a "Link" or "Unlink Phasetime account" button — only if this
// server actually has SSO configured at all (server/config/phasetime.js)
// — toggling based on whether this account currently has one linked
// (User.hasPhasetimeLink, see server/utils/serialize.js).
async function setupPhasetimeButton(state) {
  const btn = $('#phasetime-btn');
  let enabled = false;
  try {
    ({ enabled } = await api.get('/api/auth/sso/status'));
  } catch {
    // stays disabled/hidden
  }
  if (!enabled) return;

  btn.classList.remove('hidden');
  renderPhasetimeButtonState(btn, state.currentUser.hasPhasetimeLink);

  btn.addEventListener('click', async () => {
    if (!state.currentUser.hasPhasetimeLink) {
      // A plain navigation, not a fetch — this is a protected GET route
      // that redirects to Phasetime and back; the browser needs to
      // actually follow that redirect chain.
      window.location.href = '/api/auth/sso/phasetime/link';
      return;
    }
    if (!confirm('Unlink your Phasetime account? You can link it again any time.')) return;
    try {
      const { user } = await api.post('/api/auth/sso/phasetime/unlink', {});
      state.currentUser.hasPhasetimeLink = user.hasPhasetimeLink;
      renderPhasetimeButtonState(btn, user.hasPhasetimeLink);
    } catch (err) {
      alert(err.message || 'Could not unlink your Phasetime account.');
    }
  });
}

function renderPhasetimeButtonState(btn, isLinked) {
  btn.title = isLinked ? 'Unlink Phasetime account' : 'Link Phasetime account';
  btn.querySelector('i').className = `fa-solid fa-shield-halved text-sm ${isLinked ? 'text-harmony' : ''}`;
}

// The Phasetime "link" flow (server/controllers/ssoController.js)
// redirects back here, rather than to the login page — linking only
// makes sense for someone who's already signed in.
function showSsoLinkResultIfAny() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('ssoLinked')) {
    alert('Your Phasetime account is now linked.');
  } else if (params.get('ssoError')) {
    const code = params.get('ssoError');
    alert(SSO_LINK_ERROR_MESSAGES[code] || 'Something went wrong linking your Phasetime account.');
  } else {
    return;
  }
  window.history.replaceState({}, '', window.location.pathname);
}

bootstrap().catch((err) => {
  console.error('Failed to start UnisonTalk:', err);
  document.body.innerHTML =
    '<div class="min-h-screen flex items-center justify-center text-center px-6"><p class="text-ember">Something went wrong loading the app. Check the console and try refreshing.</p></div>';
});
