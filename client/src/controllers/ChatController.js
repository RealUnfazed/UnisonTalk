import { api } from '../api.js';
import { $ } from '../utils/dom.js';
import { getSecretChatKey } from '../crypto/chatKeys.js';
import { encryptText, decryptText, encryptBytes, decryptBytes, b64ToBuf } from '../crypto/webcrypto.js';
import { getOrCreateIdentity } from '../crypto/identity.js';
import { formatFileSize } from '../utils/format.js';

// The "Controller" in this client-side MVC split: the only layer that
// talks to AppState (the Model), the Views, the Socket.IO connection, the
// REST API, and the crypto module all at once. Views never call the API or
// touch crypto directly; AppState never renders anything.
//
// Every chat is one of two kinds (see chat.isSecret):
//   Cloud Chat (default)  — plain text/files, stored server-side, synced
//                            everywhere on login. No crypto touches these.
//   Secret Chat           — genuinely end-to-end encrypted, device-bound,
//                            opt-in. Only these ever call into crypto/*.
export class ChatController {
  constructor({ state, sidebarView, chatView, modalView, socket }) {
    this.state = state;
    this.sidebar = sidebarView;
    this.chat = chatView;
    this.modal = modalView;
    this.socket = socket;

    // Secret Chat identity, created lazily on first use — see ensureIdentity().
    this.myIdentity = null;
    this.identityPromise = null;

    this.oldestLoaded = new Map(); // chatId -> createdAt cursor of oldest message we have
    this.reachedStart = new Set();
    this.pendingFile = null;
    this.typingTimeout = null;
    this.typingHideTimers = new Map();

    this.previewCache = new Map(); // messageId -> preview string | null
    this.previewInFlight = new Set();

    // messageId -> attachment display info (see buildCloudAttachmentInfo /
    // prepareSecretAttachmentInfo). Populated eagerly whenever a bubble
    // with an attachment is built, so filename/size/preview show up
    // immediately instead of behind a click.
    this.attachmentCache = new Map();

    this.groupSelected = new Map(); // username -> user (for the "new group" modal)
    this.chatModalMode = 'cloud'; // which kind the open "new chat" modal will create

    this.state.addEventListener('chats:changed', () => this.renderSidebar());

    this.wireComposer();
    this.wireSockets();
    this.wireModals();
    this.wireSidebarFilter();
  }

  // -------------------------------------------------------------------
  // Secret Chat identity (lazy — Cloud Chats never touch this)
  // -------------------------------------------------------------------

  async ensureIdentity() {
    if (this.myIdentity) return this.myIdentity;
    if (this.identityPromise) return this.identityPromise;

    this.identityPromise = (async () => {
      const { keyPair, publicKeyB64, isNewDevice, mismatched } = await getOrCreateIdentity(
        this.state.currentUser.id,
        this.state.currentUser.publicKey
      );

      if (isNewDevice) {
        alert(
          "This browser doesn't have your Secret Chat key from another device.\n\n" +
            "A fresh key was just created here. Secret Chats from before this point won't be " +
            "readable on this device — that mirrors how Telegram's own Secret Chats work. " +
            "Your Cloud Chats aren't affected at all."
        );
      } else if (mismatched) {
        alert(
          "Your Secret Chat key didn't match what's on file for your account, so it's been " +
            "re-synced automatically.\n\n" +
            'If any Secret Chat messages now show "Unable to decrypt this message," that\'s ' +
            "why — they were encrypted under the previous key pairing and can't be recovered. " +
            "New messages from now on will work normally. Your Cloud Chats aren't affected."
        );
      }

      if (publicKeyB64 !== this.state.currentUser.publicKey) {
        await api.post('/api/auth/keys', { publicKey: publicKeyB64 });
        this.state.currentUser.publicKey = publicKeyB64;
      }

      const identity = { keyPair, publicKeyB64 };
      this.myIdentity = identity;
      return identity;
    })();

    try {
      return await this.identityPromise;
    } finally {
      this.identityPromise = null;
    }
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
      if (!msg || msg.attachment) return;

      if (!chat.isSecret) {
        // Cloud chats: content is already plain — nothing to decrypt.
        if (msg.content) this.previewCache.set(msg.id, msg.content);
        return;
      }

      if (!msg.ciphertext) return;
      if (this.previewCache.has(msg.id) || this.previewInFlight.has(msg.id)) return;

      this.previewInFlight.add(msg.id);
      this.decryptSecretMessage(chat, msg)
        .then((text) => this.previewCache.set(msg.id, text))
        .catch(() => this.previewCache.set(msg.id, null))
        .finally(() => {
          this.previewInFlight.delete(msg.id);
          this.renderSidebar();
        });
    });
  }

  async decryptSecretMessage(chat, msg) {
    if (!msg.ciphertext) return null;
    await this.ensureIdentity();
    const key = await getSecretChatKey(chat, this.myIdentity.keyPair, this.state.currentUser.id);
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

    let key = null;
    if (chat.isSecret) {
      try {
        await this.ensureIdentity();
        key = await getSecretChatKey(chat, this.myIdentity.keyPair, this.state.currentUser.id);
      } catch (err) {
        this.chat.showThreadError(err.message);
        return;
      }
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
    let decrypted;
    if (chat.isSecret) {
      decrypted = { text: null, decryptFailed: false };
      if (msg.ciphertext) {
        try {
          decrypted = { text: await decryptText(key, msg.ciphertext, msg.iv), decryptFailed: false };
        } catch {
          decrypted = { text: null, decryptFailed: true };
        }
      }
    } else {
      decrypted = { text: msg.content || null, decryptFailed: false };
    }

    let attachmentInfo = null;
    if (msg.attachment) {
      attachmentInfo = chat.isSecret
        ? await this.prepareSecretAttachmentInfo(msg, key)
        : this.buildCloudAttachmentInfo(msg);
    }

    // For Secret Chats, `key` is captured here, tied to `chat` (the
    // message's actual chat — every caller passes the chat msg belongs
    // to), and reused for downloading instead of re-deriving it later
    // from "whatever chat happens to be open right now".
    const onDownload = chat.isSecret
      ? () => this.downloadSecretAttachment(msg, key, attachmentInfo)
      : () => this.downloadCloudAttachment(attachmentInfo);

    return this.chat.buildBubble(msg, decrypted, attachmentInfo, this.state.currentUser.id, chat.isGroup, onDownload);
  }

  // -------------------------------------------------------------------
  // Cloud Chat attachments — plain files, no crypto at all.
  // -------------------------------------------------------------------

  buildCloudAttachmentInfo(msg) {
    return {
      isSecret: false,
      filename: msg.attachment.filename,
      mimeType: msg.attachment.mimeType,
      isImage: !!msg.attachment.isImage,
      size: msg.attachment.size,
      url: msg.attachment.url,
    };
  }

  downloadCloudAttachment(info) {
    const a = document.createElement('a');
    a.href = info.url;
    a.download = info.filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async uploadPlainFile(file) {
    const form = new FormData();
    form.append('file', file);
    return api.postForm('/api/upload', form);
  }

  // -------------------------------------------------------------------
  // Secret Chat attachments — encrypted client-side, decrypted on demand.
  // -------------------------------------------------------------------

  // Decrypts just the small metadata blob (filename/size/type) right away
  // — cheap, and it's what lets the UI show "photo.jpg · 2.3 MB" without
  // the person having to click anything first. For images specifically,
  // also eagerly decrypts the (typically small) image bytes for an inline
  // preview, Telegram-style; other file types stay lazy (decrypted only
  // when the person hits download) since they could be much larger.
  async prepareSecretAttachmentInfo(msg, key) {
    if (this.attachmentCache.has(msg.id)) return this.attachmentCache.get(msg.id);

    let meta;
    try {
      const metaJson = await decryptText(key, msg.attachment.metaCiphertext, msg.attachment.metaIv);
      meta = JSON.parse(metaJson);
    } catch (err) {
      console.error('Attachment metadata decrypt failed:', err);
      const info = { isSecret: true, metaFailed: true };
      this.attachmentCache.set(msg.id, info);
      return info;
    }

    const info = {
      isSecret: true,
      filename: meta.filename,
      mimeType: meta.mimeType,
      isImage: !!meta.isImage,
      size: meta.size,
      previewUrl: null,
      decryptedBlob: null,
    };

    if (info.isImage) {
      try {
        const bytes = await this.fetchAndDecryptFile(msg, key);
        info.decryptedBlob = new Blob([bytes], { type: info.mimeType || 'image/png' });
        info.previewUrl = URL.createObjectURL(info.decryptedBlob);
      } catch (err) {
        // Fine — buildAttachmentCard falls back to the filename+download
        // row when previewUrl is null, so this isn't a dead end for the user.
        console.error('Image preview decrypt failed:', err);
      }
    }

    this.attachmentCache.set(msg.id, info);
    return info;
  }

  // Downloads (if needed) and decrypts the actual file bytes, then saves
  // them straight to the browser's normal download flow — no new tab, no
  // "click to reveal a link, then click the link" two-step.
  async downloadSecretAttachment(msg, key, attachmentInfo) {
    let blob = attachmentInfo?.decryptedBlob;
    if (!blob) {
      const bytes = await this.fetchAndDecryptFile(msg, key);
      blob = new Blob([bytes], { type: attachmentInfo?.mimeType || 'application/octet-stream' });
      if (attachmentInfo) attachmentInfo.decryptedBlob = blob;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = attachmentInfo?.filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Delay revocation — some browsers start the download asynchronously
    // and revoking immediately can cancel it before it's actually read.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Fetches the encrypted bytes and decrypts them, with a distinct error
  // message for each stage (network vs. decrypt) instead of one generic
  // "something went wrong" — this is what actually makes a real failure
  // diagnosable instead of just visible.
  //
  // Deliberately goes through /api/attachments/:filename (a JSON response)
  // rather than fetching msg.attachment.url (a plain static file) directly.
  // A raw file URL — especially serving application/octet-stream with a
  // generic extension, which is exactly what ciphertext looks like — is
  // precisely the pattern download-manager browser extensions (IDM and
  // similar) watch for and hijack, intercepting the request before this
  // function ever sees the response body. A JSON API response doesn't
  // look like a downloadable file to anything, so there's nothing to grab.
  async fetchAndDecryptFile(msg, key) {
    const filename = msg.attachment.url.split('/').pop();

    let data;
    try {
      ({ data } = await api.get(`/api/attachments/${filename}`));
    } catch (err) {
      throw new Error(err.message || 'Could not reach the server to download this file.');
    }

    const cipherBuffer = b64ToBuf(data);
    try {
      return await decryptBytes(key, cipherBuffer, msg.attachment.fileIv);
    } catch (err) {
      console.error('decryptBytes failed:', err);
      throw new Error('Could not decrypt this file — the key or the stored data may not match.');
    }
  }

  async encryptAndUploadFile(file, key) {
    const fileBuffer = await file.arrayBuffer();
    const { ciphertext: fileCipher, iv: fileIv } = await encryptBytes(key, fileBuffer);

    const meta = {
      filename: file.name,
      mimeType: file.type,
      isImage: file.type.startsWith('image/'),
      size: file.size,
    };
    const { ciphertext: metaCiphertext, iv: metaIv } = await encryptText(key, JSON.stringify(meta));

    const form = new FormData();
    form.append('file', new Blob([fileCipher], { type: 'application/octet-stream' }), 'encrypted.bin');
    form.append('fileIv', fileIv);
    form.append('metaCiphertext', metaCiphertext);
    form.append('metaIv', metaIv);

    return api.postForm('/api/upload', form);
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
        let key = null;
        if (chat.isSecret) {
          await this.ensureIdentity();
          key = await getSecretChatKey(chat, this.myIdentity.keyPair, this.state.currentUser.id);
        }
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
  // Composer
  // -------------------------------------------------------------------

  wireComposer() {
    const fileInput = $('#file-input');
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      this.pendingFile = file;
      $('#attachment-preview-name').textContent = `${file.name} · ${formatFileSize(file.size)}`;
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
    const chat = this.state.chats.get(chatId);
    if (!chatId || !chat) return;

    const input = $('#message-input');
    const content = input.value.trim();
    const file = this.pendingFile;
    if (!content && !file) return;

    const sendBtn = e.target.querySelector('button[type="submit"]');
    sendBtn.disabled = true;

    try {
      const payload = { chatId };

      if (chat.isSecret) {
        await this.ensureIdentity();
        const key = await getSecretChatKey(chat, this.myIdentity.keyPair, this.state.currentUser.id);

        if (content) {
          const encrypted = await encryptText(key, content);
          payload.ciphertext = encrypted.ciphertext;
          payload.iv = encrypted.iv;
        }
        if (file) payload.attachment = await this.encryptAndUploadFile(file, key);
      } else {
        if (content) payload.content = content;
        if (file) payload.attachment = await this.uploadPlainFile(file);
      }

      await new Promise((resolve, reject) => {
        this.socket.emit('send-message', payload, (ack) => {
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

  // -------------------------------------------------------------------
  // Socket events
  // -------------------------------------------------------------------

  wireSockets() {
    this.socket.on('new-message', async (msg) => {
      const chat = this.state.chats.get(msg.chatId);
      if (chat) this.state.updateChatLastMessage(msg.chatId, msg);

      if (msg.chatId === this.state.activeChatId) {
        try {
          let key = null;
          if (chat.isSecret) {
            await this.ensureIdentity();
            key = await getSecretChatKey(chat, this.myIdentity.keyPair, this.state.currentUser.id);
          }
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
  // "New chat" / "New secret chat" / "New group" modals
  // -------------------------------------------------------------------

  wireModals() {
    // Both the "New direct chat" and "New secret chat" buttons open the
    // same modal (see ModalView's generic [data-open-modal] handler) —
    // this just also records which kind of chat this trip through the
    // modal will create.
    document.querySelectorAll('[data-open-modal="new-chat-modal"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.chatModalMode = btn.dataset.mode || 'cloud';
        const isSecret = this.chatModalMode === 'secret';
        $('#new-chat-modal-title').textContent = isSecret ? 'New secret chat' : 'New direct chat';
        $('#new-chat-modal-hint').classList.toggle('hidden', !isSecret);
      });
    });

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
    const isSecret = this.chatModalMode === 'secret';
    try {
      if (isSecret) await this.ensureIdentity(); // make sure WE have a key before attempting a secret chat
      const chat = await api.post('/api/chats/private', { username: user.username, isSecret });
      this.state.upsertChat(chat);
      this.socket.emit('join-chat', { chatId: chat.id });
      this.modal.closeNewChatModal();
      this.openChat(chat.id);
    } catch (err) {
      alert(err.message);
    }
  }

  // Groups are always Cloud Chats — see server/controllers/chatController.js.
  async createGroup() {
    const name = $('#group-name-input').value.trim();
    if (!name) return alert('Give the group a name first.');
    if (this.groupSelected.size === 0) return alert('Add at least one member.');

    try {
      const usernames = Array.from(this.groupSelected.keys());
      const chat = await api.post('/api/chats/group', { name, usernames });

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
