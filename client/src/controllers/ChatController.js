import { api } from '../api.js';
import { $ } from '../utils/dom.js';
import { getChatKey, cacheChatKey, createGroupKeyWraps } from '../crypto/chatKeys.js';
import { encryptText, decryptText, encryptBytes, decryptBytes } from '../crypto/webcrypto.js';

// The "Controller" in this client-side MVC split: the only layer that
// talks to AppState (the Model), the Views, the Socket.IO connection, the
// REST API, and the crypto module all at once. Views never call the API or
// touch crypto directly; AppState never renders anything. Keeping that
// boundary is what makes this "MVC-looking" rather than just one big file.
export class ChatController {
  constructor({ state, sidebarView, chatView, modalView, socket, keyPair }) {
    this.state = state;
    this.sidebar = sidebarView;
    this.chat = chatView;
    this.modal = modalView;
    this.socket = socket;
    this.keyPair = keyPair;

    this.oldestLoaded = new Map(); // chatId -> createdAt cursor of oldest message we have
    this.reachedStart = new Set();
    this.pendingFile = null;
    this.typingTimeout = null;
    this.typingHideTimers = new Map();

    this.previewCache = new Map(); // messageId -> decrypted string | null
    this.previewInFlight = new Set();

    this.groupSelected = new Map(); // username -> user (for the "new group" modal)

    this.state.addEventListener('chats:changed', () => this.renderSidebar());

    this.wireComposer();
    this.wireSockets();
    this.wireModals();
    this.wireSidebarFilter();
  }

  // -------------------------------------------------------------------
  // Sidebar
  // -------------------------------------------------------------------

  renderSidebar() {
    const chats = this.state.getSortedChats();
    this.sidebar.render(chats, this.state.activeChatId, this.state.currentUser.id, this.previewCache);
    this.kickOffPreviewDecryption(chats);
  }

  kickOffPreviewDecryption(chats) {
    chats.forEach((chat) => {
      const msg = chat.lastMessage;
      if (!msg || !msg.ciphertext || msg.attachment) return;
      if (this.previewCache.has(msg.id) || this.previewInFlight.has(msg.id)) return;

      this.previewInFlight.add(msg.id);
      this.decryptChatMessage(chat, msg)
        .then((text) => this.previewCache.set(msg.id, text))
        .catch(() => this.previewCache.set(msg.id, null))
        .finally(() => {
          this.previewInFlight.delete(msg.id);
          this.renderSidebar();
        });
    });
  }

  async decryptChatMessage(chat, msg) {
    if (!msg.ciphertext) return null;
    const key = await getChatKey(chat, this.keyPair, this.state.currentUser.id);
    return decryptText(key, msg.ciphertext, msg.iv);
  }

  // -------------------------------------------------------------------
  // Opening a chat + message history
  // -------------------------------------------------------------------

  async openChat(chatId) {
    this.state.setActiveChat(chatId);
    const chat = this.state.chats.get(chatId);
    if (!chat) return;

    this.chat.showActiveChat();
    this.renderSidebar();
    this.chat.renderHeader(chat, this.state.currentUser.id);
    this.chat.hideTyping();
    this.socket.emit('join-chat', { chatId });
    this.chat.showLoading();

    let key;
    try {
      key = await getChatKey(chat, this.keyPair, this.state.currentUser.id);
    } catch (err) {
      this.chat.showThreadError(err.message);
      return;
    }

    try {
      const history = await api.get(`/api/chats/${chatId}/messages`);
      this.chat.clearMessages();
      if (history.length === 0) {
        this.chat.showEmptyThread();
      } else {
        for (const msg of history) {
          this.chat.appendMessage(await this.buildBubbleFor(msg, chat, key));
        }
        this.oldestLoaded.set(chatId, history[0].createdAt);
        if (history.length < 30) this.reachedStart.add(chatId);
      }
      this.chat.scrollToBottom();
    } catch (err) {
      this.chat.showThreadError(err.message || 'Could not load messages.');
    }
  }

  async buildBubbleFor(msg, chat, key) {
    let decrypted = { text: null, decryptFailed: false };
    if (msg.ciphertext) {
      try {
        decrypted = { text: await decryptText(key, msg.ciphertext, msg.iv), decryptFailed: false };
      } catch {
        decrypted = { text: null, decryptFailed: true };
      }
    }
    return this.chat.buildBubble(msg, decrypted, this.state.currentUser.id, chat.isGroup, (m, wrapEl) =>
      this.handleAttachmentClick(m, wrapEl)
    );
  }

  // Infinite scroll: fetch older messages when scrolled near the top.
  wireMessagesScroll() {
    $('#messages').addEventListener('scroll', async (e) => {
      const el = e.currentTarget;
      const chatId = this.state.activeChatId;
      if (!chatId || el.scrollTop > 40 || this.reachedStart.has(chatId)) return;

      const oldestMsgEl = el.querySelector('[data-message-id]');
      if (!oldestMsgEl) return;

      const prevHeight = el.scrollHeight;
      try {
        const older = await api.get(
          `/api/chats/${chatId}/messages?before=${encodeURIComponent(oldestMsgEl.dataset.messageId)}`
        );
        if (older.length === 0) {
          this.reachedStart.add(chatId);
          return;
        }
        const chat = this.state.chats.get(chatId);
        const key = await getChatKey(chat, this.keyPair, this.state.currentUser.id);
        const nodes = [];
        for (const msg of older) nodes.push(await this.buildBubbleFor(msg, chat, key));
        nodes.forEach((node) => this.chat.prependMessage(node));
        this.oldestLoaded.set(chatId, older[0].createdAt);
        el.scrollTop = el.scrollHeight - prevHeight;
      } catch (err) {
        console.error('Failed to load older messages', err);
      }
    });
  }

  // -------------------------------------------------------------------
  // Attachments: decrypt on demand, not eagerly, to save bandwidth/CPU.
  // -------------------------------------------------------------------

  async handleAttachmentClick(msg, wrapEl) {
    try {
      const chat = this.state.chats.get(this.state.activeChatId);
      const key = await getChatKey(chat, this.keyPair, this.state.currentUser.id);

      const res = await fetch(msg.attachment.url);
      if (!res.ok) throw new Error('Could not download attachment');
      const cipherBuffer = await res.arrayBuffer();

      const [plainBuffer, metaJson] = await Promise.all([
        decryptBytes(key, cipherBuffer, msg.attachment.fileIv),
        decryptText(key, msg.attachment.metaCiphertext, msg.attachment.metaIv),
      ]);
      const meta = JSON.parse(metaJson);

      const blob = new Blob([plainBuffer], { type: meta.mimeType || 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(blob);
      this.chat.renderDecryptedAttachment(wrapEl, { blobUrl, filename: meta.filename, isImage: !!meta.isImage });
    } catch (err) {
      console.error('Attachment decrypt failed:', err);
      this.chat.showAttachmentError(wrapEl, 'Could not decrypt this attachment.');
    }
  }

  // -------------------------------------------------------------------
  // Composer: encrypt locally, then send
  // -------------------------------------------------------------------

  wireComposer() {
    const fileInput = $('#file-input');
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      this.pendingFile = file;
      $('#attachment-preview-name').textContent = file.name;
      $('#attachment-preview').classList.remove('hidden');
    });

    $('#attachment-remove').addEventListener('click', () => {
      this.pendingFile = null;
      fileInput.value = '';
      $('#attachment-preview').classList.add('hidden');
    });

    $('#composer').addEventListener('submit', (e) => this.handleSend(e));

    const messageInput = $('#message-input');
    messageInput.addEventListener('input', () => {
      messageInput.style.height = 'auto';
      messageInput.style.height = `${Math.min(messageInput.scrollHeight, 128)}px`;

      const chatId = this.state.activeChatId;
      if (!chatId) return;
      this.socket.emit('typing', { chatId });
      clearTimeout(this.typingTimeout);
      this.typingTimeout = setTimeout(() => this.socket.emit('stop-typing', { chatId }), 1200);
    });

    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('#composer').requestSubmit();
      }
    });

    this.wireMessagesScroll();
  }

  async handleSend(e) {
    e.preventDefault();
    const chatId = this.state.activeChatId;
    if (!chatId) return;

    const input = $('#message-input');
    const content = input.value.trim();
    const file = this.pendingFile;
    if (!content && !file) return;

    const sendBtn = e.target.querySelector('button[type="submit"]');
    sendBtn.disabled = true;

    try {
      const chat = this.state.chats.get(chatId);
      const key = await getChatKey(chat, this.keyPair, this.state.currentUser.id);

      let ciphertext = null;
      let iv = null;
      if (content) {
        const encrypted = await encryptText(key, content);
        ciphertext = encrypted.ciphertext;
        iv = encrypted.iv;
      }

      let attachment = null;
      if (file) {
        attachment = await this.encryptAndUploadFile(file, key);
      }

      await new Promise((resolve, reject) => {
        this.socket.emit('send-message', { chatId, ciphertext, iv, attachment }, (ack) => {
          if (ack && ack.error) reject(new Error(ack.error));
          else resolve();
        });
      });

      input.value = '';
      input.style.height = 'auto';
      this.pendingFile = null;
      $('#file-input').value = '';
      $('#attachment-preview').classList.add('hidden');
      this.socket.emit('stop-typing', { chatId });
    } catch (err) {
      alert(err.message);
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  // Encrypts the file's bytes AND its filename/type (as a small separate
  // ciphertext) before it ever leaves the browser, then uploads only
  // opaque bytes plus opaque metadata.
  async encryptAndUploadFile(file, key) {
    const fileBuffer = await file.arrayBuffer();
    const { ciphertext: fileCipher, iv: fileIv } = await encryptBytes(key, fileBuffer);

    const meta = { filename: file.name, mimeType: file.type, isImage: file.type.startsWith('image/') };
    const { ciphertext: metaCiphertext, iv: metaIv } = await encryptText(key, JSON.stringify(meta));

    const form = new FormData();
    form.append('file', new Blob([fileCipher], { type: 'application/octet-stream' }), 'encrypted.bin');
    form.append('fileIv', fileIv);
    form.append('metaCiphertext', metaCiphertext);
    form.append('metaIv', metaIv);

    return api.postForm('/api/upload', form);
  }

  // -------------------------------------------------------------------
  // Socket events
  // -------------------------------------------------------------------

  wireSockets() {
    this.socket.on('new-message', async (msg) => {
      const chat = this.state.chats.get(msg.chatId);
      if (chat) this.state.updateChatLastMessage(msg.chatId, msg);

      if (msg.chatId === this.state.activeChatId) {
        try {
          const key = await getChatKey(chat, this.keyPair, this.state.currentUser.id);
          this.chat.appendMessage(await this.buildBubbleFor(msg, chat, key));
        } catch (err) {
          console.error('Failed to render incoming message:', err);
        }
        if (msg.sender.id !== this.state.currentUser.id) this.chat.hideTyping();
      }
    });

    this.socket.on('chat-created', (chat) => {
      if (this.state.chats.has(chat.id)) return;
      this.state.upsertChat(chat);
      this.socket.emit('join-chat', { chatId: chat.id });
    });

    this.socket.on('typing', ({ chatId, userId }) => {
      if (chatId !== this.state.activeChatId || userId === this.state.currentUser.id) return;
      const chat = this.state.chats.get(chatId);
      const user = chat ? chat.participants.find((p) => p.id === userId) : null;
      this.chat.showTyping(user ? user.username : 'Someone');

      clearTimeout(this.typingHideTimers.get(userId));
      this.typingHideTimers.set(userId, setTimeout(() => this.chat.hideTyping(), 3000));
    });

    this.socket.on('stop-typing', ({ chatId, userId }) => {
      if (chatId !== this.state.activeChatId) return;
      clearTimeout(this.typingHideTimers.get(userId));
      this.chat.hideTyping();
    });

    this.socket.on('user-online', ({ userId }) => this.applyPresence(userId, true, null));
    this.socket.on('user-offline', ({ userId, lastSeen }) => this.applyPresence(userId, false, lastSeen));
  }

  applyPresence(userId, isOnline, lastSeen) {
    this.state.updatePresence(userId, isOnline, lastSeen);
    document.querySelectorAll(`[data-presence-for="${userId}"]`).forEach((dot) => {
      dot.classList.toggle('bg-harmony', isOnline);
      dot.classList.toggle('bg-slate/60', !isOnline);
    });
    this.chat.updateHeaderStatus(userId, isOnline, lastSeen);
  }

  // -------------------------------------------------------------------
  // "New chat" / "New group" modals
  // -------------------------------------------------------------------

  wireModals() {
    this.debouncedUserSearch($('#user-search-input'), (users) => {
      this.modal.renderUserSearchResults(users, (user) => this.startPrivateChat(user));
    });

    this.debouncedUserSearch($('#group-user-search-input'), (users) => {
      const filtered = users.filter((u) => !this.groupSelected.has(u.username));
      this.modal.renderGroupUserSearchResults(filtered, (user) => this.addGroupMember(user));
    });

    $('#create-group-btn').addEventListener('click', () => this.createGroup());
  }

  addGroupMember(user) {
    this.groupSelected.set(user.username, user);
    this.renderGroupSelected();
    $('#group-user-search-input').value = '';
    $('#group-user-search-results').innerHTML = '';
  }

  removeGroupMember(username) {
    this.groupSelected.delete(username);
    this.renderGroupSelected();
  }

  renderGroupSelected() {
    this.modal.renderGroupSelected(this.groupSelected, (username) => this.removeGroupMember(username));
  }

  debouncedUserSearch(inputEl, onResults) {
    let handle;
    inputEl.addEventListener('input', () => {
      clearTimeout(handle);
      const q = inputEl.value.trim();
      if (!q) return onResults([]);
      handle = setTimeout(async () => {
        try {
          onResults(await api.get(`/api/users/search?q=${encodeURIComponent(q)}`));
        } catch (err) {
          console.error('User search failed:', err);
        }
      }, 250);
    });
  }

  async startPrivateChat(user) {
    try {
      const chat = await api.post('/api/chats/private', { username: user.username });
      this.state.upsertChat(chat);
      this.socket.emit('join-chat', { chatId: chat.id });
      this.modal.closeNewChatModal();
      this.openChat(chat.id);
    } catch (err) {
      alert(err.message);
    }
  }

  async createGroup() {
    const name = $('#group-name-input').value.trim();
    if (!name) return alert('Give the group a name first.');
    if (this.groupSelected.size === 0) return alert('Add at least one member.');

    try {
      const members = [
        ...this.groupSelected.values(),
        { username: this.state.currentUser.username, publicKey: this.state.currentUser.publicKey },
      ];
      const { groupKey, wrapperPublicKey, keyWraps } = await createGroupKeyWraps(this.keyPair, members);

      const chat = await api.post('/api/chats/group', { name, wrapperPublicKey, keyWraps });
      cacheChatKey(chat.id, groupKey);

      this.state.upsertChat(chat);
      this.socket.emit('join-chat', { chatId: chat.id });
      this.modal.closeNewGroupModal();
      this.groupSelected.clear();
      this.openChat(chat.id);
    } catch (err) {
      alert(err.message);
    }
  }

  // -------------------------------------------------------------------

  wireSidebarFilter() {
    $('#chat-filter').addEventListener('input', () => this.renderSidebar());
  }
}
