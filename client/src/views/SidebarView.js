import { $, el } from '../utils/dom.js';
import { avatarFor, formatRelative } from '../utils/format.js';

// Views only know how to draw the DOM from data they're given, and report
// user interactions back up via the callbacks passed into the constructor.
// They never touch AppState or the network directly — that's the
// Controller's job.
export class SidebarView {
  constructor({ onSelectChat }) {
    this.onSelectChat = onSelectChat;
    this.listEl = $('#chat-list');
    this.filterEl = $('#chat-filter');
  }

  renderMe(user) {
    $('#me-avatar').src = avatarFor(user.username);
    $('#me-username').textContent = user.username;
  }

  render(chats, activeChatId, myUserId, previewText) {
    const filter = this.filterEl.value.trim().toLowerCase();
    this.listEl.innerHTML = '';

    chats
      .filter((c) => !filter || c.name.toLowerCase().includes(filter))
      .forEach((chat) => this.listEl.appendChild(this.buildItem(chat, activeChatId, myUserId, previewText)));
  }

  buildItem(chat, activeChatId, myUserId, previewText) {
    const other = !chat.isGroup ? chat.participants.find((p) => p.id !== myUserId) : null;

    const avatarWrap = el('div', 'relative shrink-0', [
      el('img', 'w-11 h-11 rounded-full object-cover'),
    ]);
    avatarWrap.firstChild.src = chat.isGroup ? avatarFor(chat.name || 'Group') : other?.avatarUrl || avatarFor(chat.name);

    if (other) {
      const dot = el('span');
      dot.dataset.presenceFor = other.id;
      dot.className =
        'absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-ink ' +
        (other.isOnline ? 'bg-harmony' : 'bg-slate/60');
      avatarWrap.appendChild(dot);
    }

    const nameEl = el('p', 'text-sm font-medium truncate flex items-center gap-1');
    if (chat.isSecret) {
      nameEl.appendChild(Object.assign(document.createElement('i'), { className: 'fa-solid fa-lock text-harmony text-[10px]' }));
    }
    nameEl.appendChild(document.createTextNode(chat.name));

    const nameRow = el('div', 'flex items-center justify-between gap-2', [nameEl]);
    if (chat.lastMessage) {
      nameRow.appendChild(el('span', 'text-[11px] text-white/40 shrink-0', formatRelative(chat.lastMessage.createdAt)));
    }

    const preview = el('p', 'text-xs text-white/50 truncate', this.previewFor(chat, myUserId, previewText));
    const textWrap = el('div', 'flex-1 min-w-0', [nameRow, preview]);

    const item = el('button', null, [avatarWrap, textWrap]);
    item.type = 'button';
    item.dataset.chatId = chat.id;
    item.className =
      'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ' +
      (chat.id === activeChatId ? 'bg-white/15' : 'hover:bg-white/5');
    item.addEventListener('click', () => this.onSelectChat(chat.id));
    return item;
  }

  previewFor(chat, myUserId, previewText) {
    if (!chat.lastMessage) return chat.isGroup ? 'No messages yet — say hello' : 'Say hello 👋';
    const who =
      chat.lastMessage.sender.id === myUserId ? 'You: ' : chat.isGroup ? `${chat.lastMessage.sender.username}: ` : '';
    if (chat.lastMessage.attachment) return `${who}📎 Attachment`;

    // Decryption is async and happens off in the Controller; until that
    // resolves for this particular message, show a neutral placeholder
    // rather than blocking the whole sidebar render on it.
    const decrypted = previewText ? previewText.get(chat.lastMessage.id) : undefined;
    if (decrypted === undefined) return `${who}…`;
    if (decrypted === null) return `${who}🔒 Unable to decrypt`;
    return `${who}${decrypted}`;
  }
}
