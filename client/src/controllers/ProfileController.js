import { api } from '../api.js';
import { $, el } from '../utils/dom.js';
import { nameFor, formatRelative } from '../utils/format.js';
import { loadNotifySettings, saveNotifySettings } from '../utils/notify.js';

const SKIP_REASONS = { not_found: 'no such user', already_member: 'already in the group', blocked: 'you blocked them', privacy: 'their privacy settings' };

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

    $('#chat-header-info').addEventListener('click', () => this.openChatInfo());
    $('#group-add-btn').addEventListener('click', () => this.addMembers());
    $('#group-leave-btn').addEventListener('click', () => this.leaveGroup());
    $('#contact-block-btn').addEventListener('click', () => this.toggleBlockForContact());
    $('#blocked-banner-unblock').addEventListener('click', () => {
      const chat = this.state.getActiveChat();
      const other = chat && chat.participants.find((p) => p.id !== this.state.currentUser.id);
      if (other) this.toggleBlock(other.id);
    });
    $('#settings-notify').addEventListener('change', (e) => this.onNotifyToggle(e));
    // Keep an open member list in step with live membership changes.
    this.state.addEventListener?.('chats:changed', () => {
      const chat = this.state.getActiveChat();
      if (chat && chat.isGroup && !$('#group-modal').classList.contains('hidden')) this.renderGroupMembers(chat);
    });
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
    $('#settings-read-receipts').checked = u.privacy?.readReceipts !== false;
    $('#settings-group-invites').checked = u.privacy?.groupInvites !== false;
    const notify = loadNotifySettings();
    $('#settings-notify').checked = notify.enabled && typeof Notification !== 'undefined' && Notification.permission === 'granted';
    $('#settings-notify-preview').checked = notify.previews;
    this.loadBlockedList();
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
        privacyReadReceipts: $('#settings-read-receipts').checked,
        privacyGroupInvites: $('#settings-group-invites').checked,
        autoDownloadLimitMb: Number($('#settings-autodownload').value),
      });
      this.applyMyUser(user);
      saveNotifySettings({ enabled: $('#settings-notify').checked, previews: $('#settings-notify-preview').checked });
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

    this.renderGroupMembers(chat);
    $('#group-add-row').classList.toggle('hidden', !isAdmin);
    $('#group-add-input').value = '';
    $('#group-modal').classList.remove('hidden');
  }

  // The header opens whichever info panel fits the chat.
  openChatInfo() {
    const chat = this.state.getActiveChat();
    if (!chat) return;
    if (chat.isGroup) this.openGroupInfo();
    else this.openContactInfo();
  }

  // ----------------------- group members -----------------------

  renderGroupMembers(chat) {
    const me = this.state.currentUser;
    const iAmAdmin = chat.admin === me.id;
    const list = $('#group-members');
    list.innerHTML = '';

    chat.participants.forEach((p) => {
      const img = el('img', 'w-8 h-8 rounded-full object-cover shrink-0');
      img.src = p.avatarUrl;
      const row = el('div', 'flex items-center gap-2 px-1 py-1', [
        img,
        el('span', 'text-sm truncate flex-1', nameFor(p) + (p.id === me.id ? ' (you)' : '')),
      ]);
      if (p.id === chat.admin) row.appendChild(el('span', 'text-[11px] text-harmony shrink-0', 'creator'));

      const action = (icon, title, handler, danger = false) => {
        const btn = el('button', `w-7 h-7 shrink-0 rounded-full hover:bg-mist text-xs ${danger ? 'text-ember' : 'text-slate'}`);
        btn.type = 'button';
        btn.title = title;
        btn.appendChild(Object.assign(document.createElement('i'), { className: `fa-solid ${icon}` }));
        btn.addEventListener('click', handler);
        row.appendChild(btn);
      };
      if (p.id !== me.id) {
        if (iAmAdmin) {
          action('fa-crown', 'Make owner', () => this.transferOwner(chat, p));
          action('fa-user-minus', 'Remove from group', () => this.removeMember(chat, p), true);
        }
        const blocked = (me.blockedIds || []).includes(p.id);
        action('fa-ban', blocked ? 'Unblock' : 'Block', () => this.toggleBlock(p.id), !blocked);
      }
      list.appendChild(row);
    });
  }

  async addMembers() {
    const chat = this.state.getActiveChat();
    if (!chat) return;
    const names = $('#group-add-input').value.split(/[\s,]+/).filter(Boolean);
    if (names.length === 0) return;
    try {
      const { chat: updated, skipped } = await api.post(`/api/chats/${chat.id}/members`, { usernames: names });
      this.state.updateChat(updated);
      $('#group-add-input').value = '';
      this.renderGroupMembers(updated);
      this.showError('#group-error', skipped.length ? `Couldn't add: ${skipped.map((s) => `${s.username} (${SKIP_REASONS[s.reason]})`).join(', ')}` : null);
    } catch (err) {
      this.showError('#group-error', err.message);
    }
  }

  async removeMember(chat, person) {
    if (!window.confirm(`Remove ${nameFor(person)} from this group?`)) return;
    try {
      const { chat: updated } = await api.delete(`/api/chats/${chat.id}/members/${person.id}`);
      this.state.updateChat(updated);
      this.renderGroupMembers(updated);
    } catch (err) {
      this.showError('#group-error', err.message);
    }
  }

  async transferOwner(chat, person) {
    if (!window.confirm(`Make ${nameFor(person)} the owner? You'll lose the ability to edit the group and manage members.`)) return;
    try {
      const { chat: updated } = await api.post(`/api/chats/${chat.id}/transfer`, { userId: person.id });
      this.state.updateChat(updated);
      $('#group-modal').classList.add('hidden'); // no longer the owner: reopen to see the new view
    } catch (err) {
      this.showError('#group-error', err.message);
    }
  }

  async leaveGroup() {
    const chat = this.state.getActiveChat();
    if (!chat || !window.confirm(`Leave "${chat.name}"?${chat.admin === this.state.currentUser.id ? ' Ownership passes to the longest-standing member.' : ''}`)) return;
    try {
      await api.post(`/api/chats/${chat.id}/leave`, {});
      $('#group-modal').classList.add('hidden');
      this.chatController.dropChat(chat.id);
    } catch (err) {
      this.showError('#group-error', err.message);
    }
  }

  // ----------------------- contact info & blocking -----------------------

  openContactInfo() {
    const chat = this.state.getActiveChat();
    const other = chat && chat.participants.find((p) => p.id !== this.state.currentUser.id);
    if (!other) return;
    $('#contact-avatar').src = other.avatarUrl;
    $('#contact-name').textContent = nameFor(other);
    $('#contact-username').textContent = `@${other.username}`;
    $('#contact-status').textContent = other.isOnline ? 'online' : other.lastSeen ? `last seen ${formatRelative(other.lastSeen)}` : 'last seen recently';
    this.renderContactBlock();
    $('#contact-modal').classList.remove('hidden');
  }

  contactUser() {
    const chat = this.state.getActiveChat();
    return chat && !chat.isGroup ? chat.participants.find((p) => p.id !== this.state.currentUser.id) : null;
  }

  renderContactBlock() {
    const other = this.contactUser();
    if (!other) return;
    const blocked = (this.state.currentUser.blockedIds || []).includes(other.id);
    const btn = $('#contact-block-btn');
    btn.textContent = blocked ? 'Unblock' : 'Block this person';
    btn.className = `w-full text-sm font-medium rounded-lg py-2.5 transition-colors ${blocked ? 'bg-mist text-ink hover:bg-black/5' : 'bg-ember/10 text-ember hover:bg-ember/20'}`;
  }

  toggleBlockForContact() {
    const other = this.contactUser();
    if (other) this.toggleBlock(other.id);
  }

  async toggleBlock(userId) {
    const blocked = (this.state.currentUser.blockedIds || []).includes(userId);
    if (!blocked && !window.confirm("Block this person? They won't be able to message you or add you to groups, and you'll stop seeing each other's online status.")) return;
    try {
      const { user } = blocked ? await api.delete(`/api/users/${userId}/block`) : await api.post(`/api/users/${userId}/block`, {});
      Object.assign(this.state.currentUser, user);
      const chat = this.state.getActiveChat();
      if (chat) {
        this.chatController.applyBlockState(chat);
        if (chat.isGroup) this.renderGroupMembers(chat);
      }
      this.renderContactBlock();
      if (!$('#settings-modal').classList.contains('hidden')) this.loadBlockedList();
    } catch (err) {
      alert(err.message);
    }
  }

  async loadBlockedList() {
    const list = $('#settings-blocked-list');
    try {
      const users = await api.get('/api/users/blocked');
      list.innerHTML = '';
      if (users.length === 0) list.appendChild(el('p', 'text-xs text-slate', 'No one blocked.'));
      users.forEach((u) => {
        const img = el('img', 'w-7 h-7 rounded-full object-cover shrink-0');
        img.src = u.avatarUrl;
        const unblock = el('button', 'text-xs text-ember hover:underline shrink-0', 'Unblock');
        unblock.type = 'button';
        unblock.addEventListener('click', () => this.toggleBlock(u.id));
        list.appendChild(el('div', 'flex items-center gap-2', [img, el('span', 'text-sm truncate flex-1', nameFor(u)), unblock]));
      });
    } catch {
      list.textContent = 'Could not load blocked people.';
    }
  }

  // ----------------------- notifications -----------------------

  async onNotifyToggle(e) {
    if (!e.target.checked) return;
    if (typeof Notification === 'undefined') {
      e.target.checked = false;
      this.showError('#settings-error', 'This browser does not support desktop notifications.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      e.target.checked = false;
      this.showError('#settings-error', 'Notifications are blocked for this site — allow them in your browser settings first.');
    }
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
