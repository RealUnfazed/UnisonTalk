import { api } from '../api.js';
import { $, el } from '../utils/dom.js';
import { nameFor } from '../utils/format.js';

// Owns the two "edit something about identity" modals: Settings (my own
// profile, privacy, media) and Group info (name/description/picture,
// editable by the group's creator only). Everything it changes flows back
// through AppState / the existing controller's re-render path.
export class ProfileController {
  constructor({ state, sidebarView, chatView, chatController }) {
    this.state = state;
    this.sidebar = sidebarView;
    this.chatView = chatView;
    this.chatController = chatController;

    $('#settings-btn').addEventListener('click', () => this.openSettings());
    $('#settings-autodownload').addEventListener('input', () => this.renderAutoLabel());
    $('#settings-avatar-input').addEventListener('change', (e) => this.uploadMyAvatar(e));
    $('#settings-avatar-remove').addEventListener('click', () => this.removeMyAvatar());
    $('#settings-save').addEventListener('click', () => this.saveSettings());

    $('#chat-header-info').addEventListener('click', () => this.openGroupInfo());
    $('#group-avatar-input').addEventListener('change', (e) => this.uploadGroupAvatar(e));
    $('#group-save').addEventListener('click', () => this.saveGroup());
  }

  // ----------------------------- Settings -----------------------------

  openSettings() {
    const u = this.state.currentUser;
    $('#settings-avatar').src = u.avatarUrl;
    $('#settings-username').textContent = `@${u.username}`;
    $('#settings-display-name').value = u.displayName || '';
    $('#settings-show-last-seen').checked = u.privacy?.showLastSeen !== false;
    $('#settings-discoverable').checked = u.privacy?.discoverable !== false;
    $('#settings-autodownload').value = u.autoDownloadLimitMb ?? 5;
    this.renderAutoLabel();
    this.showError('#settings-error', null);
    $('#settings-modal').classList.remove('hidden');
  }

  renderAutoLabel() {
    const v = Number($('#settings-autodownload').value);
    $('#settings-autodownload-label').textContent = v === 0 ? 'Off — always ask first' : `${v} MB`;
  }

  showError(sel, message) {
    const node = $(sel);
    node.textContent = message || '';
    node.classList.toggle('hidden', !message);
  }

  // Merge the server's fresh copy of my account into the live object
  // (kept by reference so everything holding state.currentUser sees it),
  // then redraw the places that show it.
  applyMyUser(user) {
    Object.assign(this.state.currentUser, user);
    this.sidebar.renderMe(this.state.currentUser);
    this.chatController.renderSidebar();
    $('#settings-avatar').src = this.state.currentUser.avatarUrl;
  }

  async uploadMyAvatar(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const form = new FormData();
      form.append('file', file);
      const { user } = await api.postForm('/api/users/me/avatar', form);
      this.applyMyUser(user);
      this.showError('#settings-error', null);
    } catch (err) {
      this.showError('#settings-error', err.message);
    }
  }

  async removeMyAvatar() {
    try {
      const { user } = await api.delete('/api/users/me/avatar');
      this.applyMyUser(user);
    } catch (err) {
      this.showError('#settings-error', err.message);
    }
  }

  async saveSettings() {
    try {
      const { user } = await api.patch('/api/users/me', {
        displayName: $('#settings-display-name').value,
        privacyShowLastSeen: $('#settings-show-last-seen').checked,
        privacyDiscoverable: $('#settings-discoverable').checked,
        autoDownloadLimitMb: Number($('#settings-autodownload').value),
      });
      this.applyMyUser(user);
      $('#settings-modal').classList.add('hidden');
    } catch (err) {
      this.showError('#settings-error', err.message);
    }
  }

  // ---------------------------- Group info ----------------------------

  openGroupInfo() {
    const chat = this.state.getActiveChat();
    if (!chat || !chat.isGroup) return;

    const isAdmin = chat.admin === this.state.currentUser.id;
    $('#group-avatar').src = this.chatAvatar(chat);
    $('#group-name-edit').value = chat.name;
    $('#group-desc-edit').value = chat.description || '';
    $('#group-name-edit').disabled = !isAdmin;
    $('#group-desc-edit').disabled = !isAdmin;
    $('#group-avatar-label').classList.toggle('hidden', !isAdmin);
    $('#group-save').classList.toggle('hidden', !isAdmin);
    $('#group-readonly-note').classList.toggle('hidden', isAdmin);
    this.showError('#group-error', null);

    const list = $('#group-members');
    list.innerHTML = '';
    chat.participants.forEach((p) => {
      const img = el('img', 'w-8 h-8 rounded-full object-cover');
      img.src = p.avatarUrl;
      const row = el('div', 'flex items-center gap-3 px-1 py-1', [img, el('span', 'text-sm', nameFor(p))]);
      if (p.id === chat.admin) row.appendChild(el('span', 'text-[11px] text-harmony ml-auto', 'creator'));
      list.appendChild(row);
    });

    $('#group-modal').classList.remove('hidden');
  }

  chatAvatar(chat) {
    return chat.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(chat.name)}&background=random&bold=true`;
  }

  applyChat(chat) {
    this.state.updateChat(chat);
    this.chatView.renderHeader(chat, this.state.currentUser.id);
    $('#group-avatar').src = this.chatAvatar(chat);
  }

  async uploadGroupAvatar(e) {
    const chat = this.state.getActiveChat();
    const file = e.target.files[0];
    e.target.value = '';
    if (!chat || !file) return;
    try {
      const form = new FormData();
      form.append('file', file);
      this.applyChat(await api.postForm(`/api/chats/${chat.id}/avatar`, form));
      this.showError('#group-error', null);
    } catch (err) {
      this.showError('#group-error', err.message);
    }
  }

  async saveGroup() {
    const chat = this.state.getActiveChat();
    if (!chat) return;
    try {
      this.applyChat(
        await api.patch(`/api/chats/${chat.id}`, {
          name: $('#group-name-edit').value,
          description: $('#group-desc-edit').value,
        })
      );
      $('#group-modal').classList.add('hidden');
    } catch (err) {
      this.showError('#group-error', err.message);
    }
  }
}
