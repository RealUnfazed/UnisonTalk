(function () {
  'use strict';

  const me = window.__CURRENT_USER__;
  const socket = io();

  /** @type {Map<string, object>} chatId -> chat object */
  const chats = new Map();
  (window.__INITIAL_CHATS__ || []).forEach((c) => chats.set(c.id, c));

  const state = {
    activeChatId: null,
    oldestLoaded: new Map(), // chatId -> createdAt cursor of oldest message we have
    reachedStart: new Set(), // chatIds where there's no more history to load
    pendingFile: null,
    typingTimeout: null,
    typingHideTimers: new Map(), // userId -> setTimeout handle
  };

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  const $ = (sel) => document.querySelector(sel);

  function avatarFor(username) {
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&bold=true`;
  }

  function otherParticipant(chat) {
    return chat.participants.find((p) => p.id !== me.id) || null;
  }

  function chatAvatar(chat) {
    if (chat.isGroup) return avatarFor(chat.name || 'Group');
    const other = otherParticipant(chat);
    return other ? other.avatarUrl : avatarFor(chat.name);
  }

  function formatClock(dateStr) {
    return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function formatRelative(dateStr) {
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;
    return new Date(dateStr).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  async function api(url, options = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ---------------------------------------------------------------------
  // "Me" panel
  // ---------------------------------------------------------------------

  $('#me-avatar').src = avatarFor(me.username);
  $('#me-username').textContent = me.username;

  // ---------------------------------------------------------------------
  // Sidebar: chat list
  // ---------------------------------------------------------------------

  function sortedChats() {
    return Array.from(chats.values()).sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
    );
  }

  function renderChatList() {
    const list = $('#chat-list');
    const filter = $('#chat-filter').value.trim().toLowerCase();
    list.innerHTML = '';

    sortedChats()
      .filter((c) => !filter || c.name.toLowerCase().includes(filter))
      .forEach((chat) => list.appendChild(buildChatListItem(chat)));
  }

  function buildChatListItem(chat) {
    const item = document.createElement('button');
    item.type = 'button';
    item.dataset.chatId = chat.id;
    item.className =
      'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ' +
      (chat.id === state.activeChatId ? 'bg-white/15' : 'hover:bg-white/5');

    const other = !chat.isGroup ? otherParticipant(chat) : null;

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'relative shrink-0';
    const img = document.createElement('img');
    img.src = chatAvatar(chat);
    img.className = 'w-11 h-11 rounded-full object-cover';
    avatarWrap.appendChild(img);

    if (other) {
      const dot = document.createElement('span');
      dot.dataset.presenceFor = other.id;
      dot.className =
        'absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-ink ' +
        (other.isOnline ? 'bg-harmony' : 'bg-slate/60');
      avatarWrap.appendChild(dot);
    }
    item.appendChild(avatarWrap);

    const textWrap = document.createElement('div');
    textWrap.className = 'flex-1 min-w-0';

    const topRow = document.createElement('div');
    topRow.className = 'flex items-center justify-between gap-2';
    const name = document.createElement('p');
    name.className = 'text-sm font-medium truncate';
    name.textContent = chat.name;
    topRow.appendChild(name);
    if (chat.lastMessage) {
      const time = document.createElement('span');
      time.className = 'text-[11px] text-white/40 shrink-0';
      time.textContent = formatRelative(chat.lastMessage.createdAt);
      topRow.appendChild(time);
    }
    textWrap.appendChild(topRow);

    const preview = document.createElement('p');
    preview.className = 'text-xs text-white/50 truncate';
    preview.textContent = previewText(chat);
    textWrap.appendChild(preview);

    item.appendChild(textWrap);
    item.addEventListener('click', () => openChat(chat.id));
    return item;
  }

  function previewText(chat) {
    if (!chat.lastMessage) return chat.isGroup ? 'No messages yet — say hello' : 'Say hello 👋';
    const who = chat.lastMessage.sender.id === me.id ? 'You: ' : chat.isGroup ? `${chat.lastMessage.sender.username}: ` : '';
    if (chat.lastMessage.attachment) return `${who}📎 ${chat.lastMessage.attachment.filename}`;
    return `${who}${chat.lastMessage.content}`;
  }

  function upsertChat(chat) {
    chats.set(chat.id, chat);
    renderChatList();
  }

  // ---------------------------------------------------------------------
  // Opening a chat + message history
  // ---------------------------------------------------------------------

  async function openChat(chatId) {
    state.activeChatId = chatId;
    const chat = chats.get(chatId);
    if (!chat) return;

    $('#empty-state').classList.add('hidden');
    $('#active-chat').classList.remove('hidden');
    renderChatList();
    updateHeader(chat);
    hideTyping();

    socket.emit('join-chat', { chatId });

    const messagesEl = $('#messages');
    messagesEl.innerHTML = '<p class="text-center text-xs text-slate">Loading messages…</p>';

    try {
      const history = await api(`/api/chats/${chatId}/messages`);
      messagesEl.innerHTML = '';
      if (history.length === 0) {
        renderEmptyThread();
      } else {
        history.forEach((m) => messagesEl.appendChild(buildBubble(m)));
        state.oldestLoaded.set(chatId, history[0].createdAt);
        if (history.length < 30) state.reachedStart.add(chatId);
      }
      scrollToBottom();
    } catch (err) {
      messagesEl.innerHTML = `<p class="text-center text-xs text-ember">${err.message}</p>`;
    }
  }

  function renderEmptyThread() {
    const wrap = document.createElement('div');
    wrap.className = 'h-full flex items-center justify-center text-slate text-sm';
    wrap.textContent = 'No messages yet. Break the silence.';
    $('#messages').appendChild(wrap);
  }

  function updateHeader(chat) {
    $('#chat-header-avatar').src = chatAvatar(chat);
    $('#chat-header-name').textContent = chat.name;
    const other = !chat.isGroup ? otherParticipant(chat) : null;
    const statusEl = $('#chat-header-status');
    delete statusEl.dataset.presenceStatusFor;
    if (chat.isGroup) {
      statusEl.textContent = `${chat.participants.length} members`;
    } else if (other) {
      statusEl.textContent = other.isOnline ? 'Online' : lastSeenLabel(other.lastSeen);
      statusEl.dataset.presenceStatusFor = other.id;
    }
  }

  function lastSeenLabel(lastSeen) {
    if (!lastSeen) return 'Offline';
    return `Last seen ${formatRelative(lastSeen)} ago`;
  }

  // Infinite scroll: fetch older messages when scrolled near the top.
  $('#messages').addEventListener('scroll', async function () {
    const el = this;
    const chatId = state.activeChatId;
    if (!chatId || el.scrollTop > 40 || state.reachedStart.has(chatId)) return;

    const cursor = state.oldestLoaded.get(chatId);
    if (!cursor) return;

    const prevHeight = el.scrollHeight;
    try {
      const older = await api(
        `/api/chats/${chatId}/messages?before=${encodeURIComponent(cursorMessageId(chatId))}`
      );
      if (older.length === 0) {
        state.reachedStart.add(chatId);
        return;
      }
      older.reverse().forEach((m) => el.insertBefore(buildBubble(m), el.firstChild));
      state.oldestLoaded.set(chatId, older[older.length - 1].createdAt);
      el.scrollTop = el.scrollHeight - prevHeight;
    } catch (err) {
      console.error('Failed to load older messages', err);
    }
  });

  // The API paginates by message id ("before"), but we track cursors by
  // createdAt for simplicity — this looks up the id of the oldest rendered
  // message so we can ask the server for whatever came before it.
  function cursorMessageId(chatId) {
    const messagesEl = $('#messages');
    const first = messagesEl.querySelector('[data-message-id]');
    return first ? first.dataset.messageId : '';
  }

  // ---------------------------------------------------------------------
  // Rendering messages
  // ---------------------------------------------------------------------

  function buildBubble(msg) {
    const isMe = msg.sender.id === me.id;
    const row = document.createElement('div');
    row.className = `flex ${isMe ? 'justify-end' : 'justify-start'} items-end gap-2`;
    row.dataset.messageId = msg.id;

    if (!isMe) {
      const img = document.createElement('img');
      img.src = msg.sender.avatarUrl || avatarFor(msg.sender.username || '?');
      img.className = 'w-7 h-7 rounded-full object-cover shrink-0';
      row.appendChild(img);
    }

    const bubble = document.createElement('div');
    bubble.className =
      `max-w-[60%] px-3.5 py-2.5 ${isMe ? 'bubble-own bg-signal/90 text-ink' : 'bubble-other bg-white border border-black/5 text-ink'}`;

    const chat = chats.get(state.activeChatId);
    if (!isMe && chat && chat.isGroup) {
      const name = document.createElement('p');
      name.className = 'text-[11px] font-semibold text-harmony mb-0.5';
      name.textContent = msg.sender.username || '';
      bubble.appendChild(name);
    }

    if (msg.content) {
      const p = document.createElement('p');
      p.className = 'text-sm whitespace-pre-wrap break-words';
      p.textContent = msg.content;
      bubble.appendChild(p);
    }

    if (msg.attachment) {
      bubble.appendChild(buildAttachment(msg.attachment));
    }

    const time = document.createElement('p');
    time.className = `text-[10px] mt-1 ${isMe ? 'text-ink/50' : 'text-slate'}`;
    time.textContent = formatClock(msg.createdAt);
    bubble.appendChild(time);

    row.appendChild(bubble);
    return row;
  }

  function buildAttachment(attachment) {
    if (attachment.isImage) {
      const link = document.createElement('a');
      link.href = attachment.url;
      link.target = '_blank';
      link.rel = 'noopener';
      const img = document.createElement('img');
      img.src = attachment.url;
      img.className = 'rounded-lg max-w-full max-h-64 mt-1';
      link.appendChild(img);
      return link;
    }
    const link = document.createElement('a');
    link.href = attachment.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'flex items-center gap-2 mt-1 text-sm underline decoration-dotted';
    link.innerHTML = '<i class="fa-solid fa-file-arrow-down"></i> ';
    link.append(attachment.filename);
    return link;
  }

  function appendMessage(msg) {
    const messagesEl = $('#messages');
    const emptyNotice = messagesEl.querySelector('.h-full');
    if (emptyNotice) emptyNotice.remove();
    messagesEl.appendChild(buildBubble(msg));
    scrollToBottom();
  }

  function scrollToBottom() {
    const el = $('#messages');
    el.scrollTop = el.scrollHeight;
  }

  // ---------------------------------------------------------------------
  // Composer: sending messages + attachments
  // ---------------------------------------------------------------------

  const fileInput = $('#file-input');
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    state.pendingFile = file;
    $('#attachment-preview-name').textContent = file.name;
    $('#attachment-preview').classList.remove('hidden');
  });

  $('#attachment-remove').addEventListener('click', () => {
    state.pendingFile = null;
    fileInput.value = '';
    $('#attachment-preview').classList.add('hidden');
  });

  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const chatId = state.activeChatId;
    if (!chatId) return;

    const input = $('#message-input');
    const content = input.value.trim();
    const file = state.pendingFile;

    if (!content && !file) return;

    const sendBtn = e.target.querySelector('button[type="submit"]');
    sendBtn.disabled = true;

    try {
      let attachment = null;
      if (file) {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch('/api/upload', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        attachment = data;
      }

      socket.emit('send-message', { chatId, content, attachment }, (ack) => {
        if (ack && ack.error) alert(ack.error);
      });

      input.value = '';
      input.style.height = 'auto';
      state.pendingFile = null;
      fileInput.value = '';
      $('#attachment-preview').classList.add('hidden');
      socket.emit('stop-typing', { chatId });
    } catch (err) {
      alert(err.message);
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  });

  // Grow the textarea as the user types, and send typing pulses.
  const messageInput = $('#message-input');
  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 128)}px`;

    const chatId = state.activeChatId;
    if (!chatId) return;
    socket.emit('typing', { chatId });
    clearTimeout(state.typingTimeout);
    state.typingTimeout = setTimeout(() => socket.emit('stop-typing', { chatId }), 1200);
  });

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });

  // ---------------------------------------------------------------------
  // Typing indicator (incoming)
  // ---------------------------------------------------------------------

  function showTyping(username) {
    const el = $('#typing-indicator');
    el.querySelector('span').textContent = `${username} is typing`;
    el.classList.remove('hidden');
    el.classList.add('flex');
  }

  function hideTyping() {
    const el = $('#typing-indicator');
    el.classList.add('hidden');
    el.classList.remove('flex');
  }

  // ---------------------------------------------------------------------
  // Presence (online / offline) DOM updates
  // ---------------------------------------------------------------------

  function setPresence(userId, isOnline, lastSeen) {
    document.querySelectorAll(`[data-presence-for="${userId}"]`).forEach((dot) => {
      dot.classList.toggle('bg-harmony', isOnline);
      dot.classList.toggle('bg-slate/60', !isOnline);
    });

    chats.forEach((chat) => {
      const p = chat.participants.find((x) => x.id === userId);
      if (p) {
        p.isOnline = isOnline;
        if (lastSeen) p.lastSeen = lastSeen;
      }
    });

    const statusEl = document.querySelector(`[data-presence-status-for="${userId}"]`);
    if (statusEl) statusEl.textContent = isOnline ? 'Online' : lastSeenLabel(lastSeen);
  }

  // ---------------------------------------------------------------------
  // Socket event wiring
  // ---------------------------------------------------------------------

  socket.on('new-message', (msg) => {
    const chat = chats.get(msg.chatId);
    if (chat) {
      chat.lastMessage = msg;
      chat.updatedAt = msg.createdAt;
    }
    renderChatList();

    if (msg.chatId === state.activeChatId) {
      appendMessage(msg);
      if (msg.sender.id !== me.id) hideTyping();
    }
  });

  socket.on('chat-created', (chat) => {
    if (chats.has(chat.id)) return;
    upsertChat(chat);
    socket.emit('join-chat', { chatId: chat.id });
  });

  socket.on('typing', ({ chatId, userId }) => {
    if (chatId !== state.activeChatId || userId === me.id) return;
    const chat = chats.get(chatId);
    const user = chat ? chat.participants.find((p) => p.id === userId) : null;
    showTyping(user ? user.username : 'Someone');

    clearTimeout(state.typingHideTimers.get(userId));
    state.typingHideTimers.set(
      userId,
      setTimeout(hideTyping, 3000)
    );
  });

  socket.on('stop-typing', ({ chatId, userId }) => {
    if (chatId !== state.activeChatId) return;
    clearTimeout(state.typingHideTimers.get(userId));
    hideTyping();
  });

  socket.on('user-online', ({ userId }) => setPresence(userId, true, null));
  socket.on('user-offline', ({ userId, lastSeen }) => setPresence(userId, false, lastSeen));

  // ---------------------------------------------------------------------
  // "New chat" / "New group" menu + modals
  // ---------------------------------------------------------------------

  const newMenuBtn = $('#new-menu-btn');
  const newMenu = $('#new-menu');
  newMenuBtn.addEventListener('click', () => newMenu.classList.toggle('hidden'));
  document.addEventListener('click', (e) => {
    if (!newMenuBtn.contains(e.target) && !newMenu.contains(e.target)) {
      newMenu.classList.add('hidden');
    }
  });

  document.querySelectorAll('[data-open-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      newMenu.classList.add('hidden');
      $(`#${btn.dataset.openModal}`).classList.remove('hidden');
    });
  });

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.closest('.fixed').classList.add('hidden');
    });
  });

  function debounce(fn, ms) {
    let handle;
    return (...args) => {
      clearTimeout(handle);
      handle = setTimeout(() => fn(...args), ms);
    };
  }

  // ---- New direct chat ----

  const userSearchInput = $('#user-search-input');
  const userSearchResults = $('#user-search-results');

  userSearchInput.addEventListener(
    'input',
    debounce(async () => {
      const q = userSearchInput.value.trim();
      userSearchResults.innerHTML = '';
      if (!q) return;
      const users = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
      users.forEach((u) => {
        const row = buildUserRow(u, async () => {
          const chat = await api('/api/chats/private', {
            method: 'POST',
            body: JSON.stringify({ username: u.username }),
          });
          upsertChat(chat);
          socket.emit('join-chat', { chatId: chat.id });
          $('#new-chat-modal').classList.add('hidden');
          userSearchInput.value = '';
          userSearchResults.innerHTML = '';
          openChat(chat.id);
        });
        userSearchResults.appendChild(row);
      });
    }, 250)
  );

  function buildUserRow(user, onClick) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'w-full flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-mist text-left';
    const img = document.createElement('img');
    img.src = user.avatarUrl;
    img.className = 'w-8 h-8 rounded-full object-cover';
    const name = document.createElement('span');
    name.className = 'text-sm font-medium';
    name.textContent = user.username;
    row.append(img, name);
    row.addEventListener('click', onClick);
    return row;
  }

  // ---- New group ----

  const groupUserSearchInput = $('#group-user-search-input');
  const groupUserSearchResults = $('#group-user-search-results');
  const groupSelectedEl = $('#group-selected');
  const groupSelected = new Map(); // username -> user

  groupUserSearchInput.addEventListener(
    'input',
    debounce(async () => {
      const q = groupUserSearchInput.value.trim();
      groupUserSearchResults.innerHTML = '';
      if (!q) return;
      const users = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
      users
        .filter((u) => !groupSelected.has(u.username))
        .forEach((u) => {
          const row = buildUserRow(u, () => {
            groupSelected.set(u.username, u);
            renderGroupSelected();
            groupUserSearchInput.value = '';
            groupUserSearchResults.innerHTML = '';
          });
          groupUserSearchResults.appendChild(row);
        });
    }, 250)
  );

  function renderGroupSelected() {
    groupSelectedEl.innerHTML = '';
    groupSelected.forEach((user, username) => {
      const chip = document.createElement('span');
      chip.className = 'inline-flex items-center gap-1.5 bg-mist text-ink text-xs font-medium pl-2.5 pr-1.5 py-1 rounded-full';
      chip.textContent = username;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      remove.className = 'text-slate hover:text-ember';
      remove.addEventListener('click', () => {
        groupSelected.delete(username);
        renderGroupSelected();
      });
      chip.appendChild(remove);
      groupSelectedEl.appendChild(chip);
    });
  }

  $('#create-group-btn').addEventListener('click', async () => {
    const name = $('#group-name-input').value.trim();
    if (!name) return alert('Give the group a name first.');
    if (groupSelected.size === 0) return alert('Add at least one member.');

    try {
      const chat = await api('/api/chats/group', {
        method: 'POST',
        body: JSON.stringify({ name, usernames: Array.from(groupSelected.keys()) }),
      });
      upsertChat(chat);
      socket.emit('join-chat', { chatId: chat.id });
      $('#new-group-modal').classList.add('hidden');
      $('#group-name-input').value = '';
      groupSelected.clear();
      renderGroupSelected();
      openChat(chat.id);
    } catch (err) {
      alert(err.message);
    }
  });

  // ---------------------------------------------------------------------
  // Sidebar filter + initial render
  // ---------------------------------------------------------------------

  $('#chat-filter').addEventListener('input', renderChatList);

  renderChatList();
})();
