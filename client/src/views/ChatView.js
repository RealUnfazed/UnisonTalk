import { $, el } from '../utils/dom.js';
import { avatarFor, formatClock, formatRelative } from '../utils/format.js';

export class ChatView {
  constructor() {
    this.emptyStateEl = $('#empty-state');
    this.activeChatEl = $('#active-chat');
    this.messagesEl = $('#messages');
    this.typingEl = $('#typing-indicator');
  }

  showEmptyState() {
    this.emptyStateEl.classList.remove('hidden');
    this.activeChatEl.classList.add('hidden');
  }

  showActiveChat() {
    this.emptyStateEl.classList.add('hidden');
    this.activeChatEl.classList.remove('hidden');
  }

  renderHeader(chat, myUserId) {
    const other = !chat.isGroup ? chat.participants.find((p) => p.id !== myUserId) : null;
    $('#chat-header-avatar').src = chat.isGroup ? avatarFor(chat.name || 'Group') : other?.avatarUrl || avatarFor(chat.name);
    $('#chat-header-name').textContent = chat.name;

    const statusEl = $('#chat-header-status');
    delete statusEl.dataset.presenceStatusFor;
    if (chat.isGroup) {
      statusEl.textContent = `${chat.participants.length} members · end-to-end encrypted`;
    } else if (other) {
      statusEl.textContent = (other.isOnline ? 'Online' : this.lastSeenLabel(other.lastSeen)) + ' · end-to-end encrypted';
      statusEl.dataset.presenceStatusFor = other.id;
    }
  }

  updateHeaderStatus(userId, isOnline, lastSeen) {
    const statusEl = $('#chat-header-status');
    if (statusEl.dataset.presenceStatusFor !== userId) return;
    statusEl.textContent = (isOnline ? 'Online' : this.lastSeenLabel(lastSeen)) + ' · end-to-end encrypted';
  }

  lastSeenLabel(lastSeen) {
    if (!lastSeen) return 'Offline';
    return `Last seen ${formatRelative(lastSeen)} ago`;
  }

  showLoading() {
    this.messagesEl.innerHTML = '';
    this.messagesEl.appendChild(el('p', 'text-center text-xs text-slate', 'Decrypting conversation…'));
  }

  showThreadError(message) {
    this.messagesEl.innerHTML = '';
    this.messagesEl.appendChild(el('p', 'text-center text-xs text-ember', message));
  }

  showEmptyThread() {
    this.messagesEl.innerHTML = '';
    this.messagesEl.appendChild(
      el('div', 'h-full flex items-center justify-center text-slate text-sm', 'No messages yet. Break the silence.')
    );
  }

  clearMessages() {
    this.messagesEl.innerHTML = '';
  }

  removeEmptyNotice() {
    const notice = this.messagesEl.querySelector('.h-full');
    if (notice) notice.remove();
  }

  // `decrypted` is { text: string|null, decryptFailed: boolean }.
  // `attachmentHandlers` is { onDownload(messageId) } used to lazily
  // decrypt+render an attachment only when it's about to be shown/clicked.
  buildBubble(msg, decrypted, myUserId, isGroup, onAttachmentClick) {
    const isMe = msg.sender.id === myUserId;
    const row = el('div', `flex ${isMe ? 'justify-end' : 'justify-start'} items-end gap-2`);
    row.dataset.messageId = msg.id;

    if (!isMe) {
      const img = el('img', 'w-7 h-7 rounded-full object-cover shrink-0');
      img.src = msg.sender.avatarUrl || avatarFor(msg.sender.username || '?');
      row.appendChild(img);
    }

    const bubble = el(
      'div',
      `max-w-[60%] px-3.5 py-2.5 ${isMe ? 'bubble-own bg-signal/90 text-ink' : 'bubble-other bg-white border border-black/5 text-ink'}`
    );

    if (!isMe && isGroup) {
      bubble.appendChild(el('p', 'text-[11px] font-semibold text-harmony mb-0.5', msg.sender.username || ''));
    }

    if (decrypted.text) {
      bubble.appendChild(el('p', 'text-sm whitespace-pre-wrap break-words', decrypted.text));
    } else if (decrypted.decryptFailed) {
      bubble.appendChild(
        el('p', 'text-sm italic text-ember flex items-center gap-1.5', [
          Object.assign(document.createElement('i'), { className: 'fa-solid fa-lock' }),
          document.createTextNode(' Unable to decrypt this message'),
        ])
      );
    }

    if (msg.attachment) {
      bubble.appendChild(this.buildAttachmentPlaceholder(msg, onAttachmentClick));
    }

    bubble.appendChild(el('p', `text-[10px] mt-1 ${isMe ? 'text-ink/50' : 'text-slate'}`, formatClock(msg.createdAt)));
    row.appendChild(bubble);
    return row;
  }

  buildAttachmentPlaceholder(msg, onAttachmentClick) {
    const wrap = el('div', 'mt-1.5 flex items-center gap-2 text-sm bg-black/5 rounded-lg px-2.5 py-2 cursor-pointer hover:bg-black/10');
    wrap.dataset.attachmentFor = msg.id;
    wrap.append(
      Object.assign(document.createElement('i'), { className: 'fa-solid fa-paperclip' }),
      document.createTextNode(' Encrypted attachment — click to decrypt')
    );
    wrap.addEventListener('click', () => onAttachmentClick(msg, wrap));
    return wrap;
  }

  // Swaps a clicked placeholder for the actual decrypted content once
  // available (an inline image, or a download link for anything else).
  renderDecryptedAttachment(wrapEl, { blobUrl, filename, isImage }) {
    wrapEl.innerHTML = '';
    wrapEl.className = 'mt-1.5';
    wrapEl.removeAttribute('data-attachment-for');

    const link = el('a');
    link.href = blobUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.download = filename;

    if (isImage) {
      const img = el('img', 'rounded-lg max-w-full max-h-64');
      img.src = blobUrl;
      link.appendChild(img);
    } else {
      link.className = 'flex items-center gap-2 text-sm underline decoration-dotted';
      link.append(
        Object.assign(document.createElement('i'), { className: 'fa-solid fa-file-arrow-down' }),
        document.createTextNode(` ${filename}`)
      );
    }
    wrapEl.appendChild(link);
  }

  showAttachmentError(wrapEl, message) {
    wrapEl.innerHTML = '';
    wrapEl.className = 'mt-1.5 text-xs text-ember';
    wrapEl.textContent = message;
  }

  appendMessage(node) {
    this.removeEmptyNotice();
    this.messagesEl.appendChild(node);
    this.scrollToBottom();
  }

  prependMessage(node) {
    this.messagesEl.insertBefore(node, this.messagesEl.firstChild);
  }

  scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  showTyping(username) {
    this.typingEl.querySelector('span').textContent = `${username} is typing`;
    this.typingEl.classList.remove('hidden');
    this.typingEl.classList.add('flex');
  }

  hideTyping() {
    this.typingEl.classList.add('hidden');
    this.typingEl.classList.remove('flex');
  }
}
