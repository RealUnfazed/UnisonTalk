// Desktop notifications: the DECISION (should this message notify, and what
// does it say?) is a pure function so it can be unit-tested; the browser's
// Notification API is only touched by the caller (ChatController).
const KEY = 'unisontalk:notifications';
const DEFAULTS = { enabled: false, previews: true };

// Stored per browser (localStorage), not on the server: whether THIS device
// should pop up notifications is a property of the device.
export function loadNotifySettings(storage = globalThis.localStorage) {
  try {
    return { ...DEFAULTS, ...JSON.parse(storage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveNotifySettings(settings, storage = globalThis.localStorage) {
  try {
    storage.setItem(KEY, JSON.stringify({ enabled: Boolean(settings.enabled), previews: Boolean(settings.previews) }));
  } catch {
    /* storage unavailable (private mode) — the setting just won't persist */
  }
}

export function notificationFor({ msg, chat, myUserId, settings, tabVisible, activeChatId }) {
  if (!settings.enabled) return null;
  if (msg.deleted || (msg.sender && msg.sender.id === myUserId)) return null;
  if (tabVisible && msg.chatId === activeChatId) return null; // you're already looking at it

  const sender = msg.sender.displayName || msg.sender.username;
  const title = chat.isGroup ? `${sender} in ${chat.name}` : sender;

  let body = 'New message';
  if (chat.isSecret) {
    // Never copy Secret Chat plaintext into the operating system's
    // notification centre — that would defeat the point of the chat.
    body = '🔒 New message';
  } else if (settings.previews) {
    if (msg.content) body = msg.content.length > 100 ? `${msg.content.slice(0, 100)}…` : msg.content;
    else if (msg.attachment) body = '📎 Attachment';
  }
  return { title, body, tag: msg.chatId };
}
