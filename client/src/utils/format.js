export function avatarFor(username) {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&bold=true`;
}

// `username` is the fixed, unique identifier (needed for search, starting
// chats, exact lookups); `displayName` is the freely-changeable cosmetic
// one. Every place that just needs "the name to show" should go through
// this rather than reading .username directly, so a display name actually
// shows up everywhere it's supposed to.
export function nameFor(user) {
  if (!user) return '';
  return user.displayName || user.username || '';
}

// One place that decides what picture represents a chat: a group's own
// uploaded picture if it has one, otherwise a generated one from its
// name; for a private chat, the other participant's avatar (which the
// server already resolves to their uploaded picture or generated one).
export function chatAvatarUrl(chat, myUserId) {
  if (chat.isGroup) return chat.avatar || avatarFor(chat.name || 'Group');
  const other = chat.participants.find((p) => p.id !== myUserId);
  return other?.avatarUrl || avatarFor(chat.name);
}

export function formatFileSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatClock(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatRelative(dateStr) {
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
