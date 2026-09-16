import { api } from '../api.js';
import { $ } from '../utils/dom.js';
import { connectSocket } from '../socket.js';
import { AppState } from '../models/AppState.js';
import { SidebarView } from '../views/SidebarView.js';
import { ChatView } from '../views/ChatView.js';
import { ModalView } from '../views/ModalView.js';
import { ChatController } from '../controllers/ChatController.js';

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
}

bootstrap().catch((err) => {
  console.error('Failed to start UnisonTalk:', err);
  document.body.innerHTML =
    '<div class="min-h-screen flex items-center justify-center text-center px-6"><p class="text-ember">Something went wrong loading the app. Check the console and try refreshing.</p></div>';
});
