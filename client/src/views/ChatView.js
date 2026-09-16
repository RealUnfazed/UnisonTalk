import { $, el } from '../utils/dom.js';
import { avatarFor, formatClock, formatRelative, formatFileSize } from '../utils/format.js';

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

    const nameEl = $('#chat-header-name');
    nameEl.innerHTML = '';
    if (chat.isSecret) {
      nameEl.appendChild(
        Object.assign(document.createElement('i'), { className: 'fa-solid fa-lock text-harmony text-xs mr-1.5' })
      );
    }
    nameEl.appendChild(document.createTextNode(chat.name));

    $('#message-input').placeholder = chat.isSecret ? 'Write an encrypted message' : 'Write a message';

    const statusEl = $('#chat-header-status');
    delete statusEl.dataset.presenceStatusFor;
    if (chat.isGroup) {
      statusEl.textContent = `${chat.participants.length} members`;
    } else if (chat.isSecret) {
      statusEl.textContent = (other?.isOnline ? 'Online' : this.lastSeenLabel(other?.lastSeen)) + ' · Secret chat, end-to-end encrypted';
      if (other) statusEl.dataset.presenceStatusFor = other.id;
    } else if (other) {
      statusEl.textContent = other.isOnline ? 'Online' : this.lastSeenLabel(other.lastSeen);
      statusEl.dataset.presenceStatusFor = other.id;
    }
  }

  updateHeaderStatus(userId, isOnline, lastSeen) {
    const statusEl = $('#chat-header-status');
    if (statusEl.dataset.presenceStatusFor !== userId) return;
    const suffix = statusEl.textContent.includes('Secret chat') ? ' · Secret chat, end-to-end encrypted' : '';
    statusEl.textContent = (isOnline ? 'Online' : this.lastSeenLabel(lastSeen)) + suffix;
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
  // `attachmentInfo` (already decrypted by the controller before this is
  // called) is one of:
  //   { metaFailed: true }                                            — couldn't even read what the file is
  //   { filename, size, mimeType, isImage: false }                    — a regular file: name + size + download button
  //   { filename, size, mimeType, isImage: true, previewUrl }         — an image, ready to show inline
  //   { filename, size, mimeType, isImage: true, previewUrl: null }   — an image whose preview failed to decrypt; falls back to the file-row layout
  buildBubble(msg, decrypted, attachmentInfo, myUserId, isGroup, onDownload) {
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

    if (attachmentInfo) {
      bubble.appendChild(this.buildAttachmentCard(attachmentInfo, onDownload));
    }

    bubble.appendChild(el('p', `text-[10px] mt-1 ${isMe ? 'text-ink/50' : 'text-slate'}`, formatClock(msg.createdAt)));
    row.appendChild(bubble);
    return row;
  }

  buildAttachmentCard(info, onDownload) {
    if (info.metaFailed) {
      return el('div', 'mt-1.5 flex items-center gap-2 text-xs text-ember bg-ember/10 rounded-lg px-2.5 py-2', [
        Object.assign(document.createElement('i'), { className: 'fa-solid fa-triangle-exclamation' }),
        document.createTextNode(' Could not read this attachment'),
      ]);
    }

    const card = el('div', 'mt-1.5');

    // Images get an inline preview, like a photo bubble in Telegram — no
    // click needed just to see it. Cloud Chats can use the file's real
    // URL directly (nothing to decrypt); Secret Chats use the
    // already-decrypted blob URL prepared in prepareSecretAttachmentInfo.
    const imageSrc = info.isSecret ? info.previewUrl : info.url;
    if (info.isImage && imageSrc) {
      const img = el('img', 'rounded-lg max-w-full max-h-64 cursor-pointer block');
      img.src = imageSrc;
      img.title = 'Click to download';
      img.addEventListener('click', () => this.triggerDownload(onDownload, img));
      card.appendChild(img);

      const caption = el('div', 'flex items-center justify-between gap-2 mt-1');
      caption.appendChild(el('span', 'text-[11px] text-slate truncate', info.filename || 'image'));
      caption.appendChild(this.buildDownloadButton(onDownload));
      card.appendChild(caption);
      return card;
    }

    // Any other file (or an image whose preview failed to decrypt): a
    // filename + size row with one explicit download action.
    const row = el('div', 'flex items-center gap-3 bg-black/5 rounded-lg px-3 py-2.5 min-w-[220px]');
    row.appendChild(
      el('div', 'w-9 h-9 rounded-lg bg-black/10 flex items-center justify-center shrink-0', [
        Object.assign(document.createElement('i'), { className: 'fa-solid fa-file text-ink/60' }),
      ])
    );
    const textCol = el('div', 'min-w-0 flex-1');
    textCol.appendChild(el('p', 'text-sm font-medium truncate', info.filename || 'Attachment'));
    textCol.appendChild(
      el('p', 'text-xs text-slate', info.size != null ? formatFileSize(info.size) : info.isSecret ? 'Encrypted file' : 'File')
    );
    row.appendChild(textCol);
    row.appendChild(this.buildDownloadButton(onDownload));
    card.appendChild(row);
    return card;
  }

  buildDownloadButton(onDownload) {
    const btn = el(
      'button',
      'shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-ink/60 hover:bg-black/10 hover:text-ink transition-colors'
    );
    btn.type = 'button';
    btn.title = 'Download';
    btn.innerHTML = '<i class="fa-solid fa-download"></i>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.triggerDownload(onDownload, btn);
    });
    return btn;
  }

  // Shared spinner-while-working handling for both the dedicated download
  // button and clicking an image preview directly.
  async triggerDownload(onDownload, triggerEl) {
    const icon = triggerEl.tagName === 'BUTTON' ? triggerEl.querySelector('i') : null;
    const prevIconClass = icon?.className;
    if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
    triggerEl.disabled = true;

    try {
      await onDownload();
    } catch (err) {
      alert(err.message || 'Could not download this attachment.');
    } finally {
      if (icon) icon.className = prevIconClass;
      triggerEl.disabled = false;
    }
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
