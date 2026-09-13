// The "Model" in this client-side MVC split: plain application state plus
// a minimal pub/sub mechanism. Views subscribe to the events they care
// about; the Controller is the only thing allowed to mutate this class's
// data. No framework, no virtual DOM — just enough structure to keep
// "what the data is" separate from "how it's drawn" and "when it changes".
export class AppState extends EventTarget {
  constructor() {
    super();
    this.currentUser = null;
    this.myKeyPair = null; // { publicKey, privateKey } CryptoKey objects
    this.chats = new Map(); // chatId -> chat object
    this.activeChatId = null;
  }

  setCurrentUser(user) {
    this.currentUser = user;
    this.emit('user:changed', user);
  }

  setKeyPair(keyPair) {
    this.myKeyPair = keyPair;
  }

  setChats(chatList) {
    this.chats = new Map(chatList.map((c) => [c.id, c]));
    this.emit('chats:changed');
  }

  upsertChat(chat) {
    this.chats.set(chat.id, chat);
    this.emit('chats:changed');
  }

  getSortedChats() {
    return Array.from(this.chats.values()).sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
    );
  }

  setActiveChat(chatId) {
    this.activeChatId = chatId;
    this.emit('chat:activated', chatId);
  }

  getActiveChat() {
    return this.activeChatId ? this.chats.get(this.activeChatId) : null;
  }

  updateChatLastMessage(chatId, message) {
    const chat = this.chats.get(chatId);
    if (chat) {
      chat.lastMessage = message;
      chat.updatedAt = message.createdAt;
      this.emit('chats:changed');
    }
  }

  updatePresence(userId, isOnline, lastSeen) {
    this.chats.forEach((chat) => {
      const participant = chat.participants.find((p) => p.id === userId);
      if (participant) {
        participant.isOnline = isOnline;
        if (lastSeen) participant.lastSeen = lastSeen;
      }
    });
    this.emit('presence:changed', { userId, isOnline, lastSeen });
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
