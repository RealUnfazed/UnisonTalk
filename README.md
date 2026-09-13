# UnisonTalk

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-realtime-black?logo=socket.io&logoColor=white)](https://socket.io)
[![E2EE](https://img.shields.io/badge/encryption-end--to--end-3E8E7E)](#security-model)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

A real-time, **end-to-end encrypted** chat platform with a genuinely separated client and server:

- **`server/`** — an Express + Socket.IO + MongoDB API, structured MVC-style (models / controllers / routes). It has no view layer and never sees a plaintext message — only ciphertext.
- **`client/`** — a framework-free, static JavaScript app (its own model / view / controller split) that does all encryption and decryption locally, using the browser's native Web Crypto API.

```
Alice's browser                          Server + MongoDB                    Bob's browser
─────────────────                        ─────────────────                  ─────────────
"Hello Bob"
     │ encrypt locally (AES-GCM)
     ▼
"8fA91x...K29="  ───────────────────▶   stores ciphertext only  ───────────▶  "8fA91x...K29="
                                          (never decrypts it)                        │ decrypt locally
                                                                                      ▼
                                                                                 "Hello Bob"
```

## Table of contents

- [Features](#features)
- [Stack](#stack)
- [Getting started](#getting-started)
- [Project structure](#project-structure)
- [How the client/server separation works](#how-the-clientserver-separation-works)
- [How the encryption works](#how-the-encryption-works)
- [Security model](#security-model)
- [How the real-time architecture works](#how-the-real-time-architecture-works)
- [Notes & possible extensions](#notes--possible-extensions)
- [Contributing](#contributing)
- [License](#license)
- [Author](#author)

## Features

- **Accounts** — register/login with hashed passwords (bcrypt), sessions stored in MongoDB
- **End-to-end encryption** — message text and file attachments are encrypted in the browser before they're ever sent; the server and database only ever hold ciphertext
- **Private & group chats** — start a 1:1 chat by username, or create a named group with multiple members
- **Online status** — presence dots update live as people connect/disconnect, even across multiple tabs
- **Typing indicators** — see when someone in the open chat is typing, in real time
- **Message history** — cursor-paginated; scroll up in a thread to load older (and still encrypted-at-rest) messages
- **Encrypted file/image attachments** — the file bytes *and* its filename/type are encrypted client-side; the server stores an opaque blob and has no idea what it is

## Stack

**Server:** Express · Socket.IO · MongoDB (Mongoose) · express-session (Mongo-backed)
**Client:** Vanilla JavaScript (ES modules, no bundler) · Web Crypto API · Tailwind CSS (CDN) · Font Awesome

## Getting started

**Prerequisites:** Node.js 18+ (for the Web Crypto API and IndexedDB, use a reasonably modern evergreen browser — Chrome, Firefox, Safari, or Edge), and a MongoDB instance (local install or a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster).

```bash
# 1. Clone the repo
git clone https://github.com/RealUnfazed/unisontalk.git
cd unisontalk

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# then edit .env: set MONGODB_URI and a random SESSION_SECRET

# 4. Run it
npm run dev      # with nodemon, auto-restarts on changes
# or
npm start
```

Then open **http://localhost:3000**, register two accounts (e.g. in two different browsers or an incognito window), and start chatting between them to see presence, typing, live messages, and encryption/decryption all in action.

## Project structure

```
server/
  server.js              Entry point: connects MongoDB, starts HTTP + Socket.IO
  app.js                 Express app config — CORS, sessions, routes, static serving
  config/db.js           MongoDB connection
  models/                Mongoose schemas: User, Chat, Message (ciphertext, never plaintext)
  controllers/           Request handlers — auth, chats/messages, uploads
  routes/                Route definitions, wired to controllers
  middleware/             Session-based auth guard, Multer upload config
  sockets/index.js        All Socket.IO logic — routes ciphertext, never reads it
  utils/serialize.js      Shapes Mongoose docs into client-friendly JSON
  uploads/                Encrypted attachment blobs live here

client/
  public/                 Static HTML shells: index.html, login.html, register.html, 404.html
  src/
    crypto/               webcrypto.js (primitives), keyStore.js (IndexedDB), identity.js,
                           chatKeys.js — the entire E2EE implementation
    models/AppState.js    Client-side state + a small pub/sub mechanism
    views/                Pure rendering: SidebarView, ChatView, ModalView
    controllers/          ChatController — wires sockets, the API, crypto, and views together
    pages/                Per-page bootstrap scripts (chatPage, loginPage, registerPage)
    api.js, socket.js, config.js   Thin wrappers around fetch / Socket.IO / base URLs
```

## How the client/server separation works

The server is a **pure JSON + WebSocket API** — there's no `res.render()` anywhere in it, and no template engine. Every response is JSON (or, for attachments, opaque encrypted bytes). The client is a **fully static app**: plain HTML files plus ES modules, with no build step (`<script type="module">` handles the model/view/controller file splitting natively in the browser).

By default, `server/app.js` also serves `client/` as static files, so `npm run dev` gives you one command and one running process — convenient for development. But nothing in the client actually depends on that:

- `client/src/config.js` exports `API_BASE_URL` / `SOCKET_URL`. Point these at a different host and the client works talking to a server running anywhere else.
- The server has CORS enabled (`server/app.js`) and reflects the request's origin with `credentials: true` by default, so a client served from a different port or domain during development just works. Set `ALLOWED_ORIGIN` in `.env` to lock this down to real origin(s) before deploying.

In other words: this repo ships as one deployable unit for convenience, but the client and server are two independent codebases that only communicate over HTTP/WebSocket — you could deploy `client/` to a static host (Netlify, S3, GitHub Pages) and `server/` to a Node host separately without changing any application logic.

## How the encryption works

Every user has a long-term **ECDH key pair** (P-256 curve), generated in the browser with `crypto.subtle.generateKey` the first time they log in. Only the **public** half is ever sent to the server (`POST /api/auth/keys`) — it's stored in `User.publicKey` as a simple directory, the same way an email server stores addresses, not passwords. The private key is generated, used, and persisted (in IndexedDB) entirely client-side and never crosses the network in any form.

**Private (1:1) chats** need no extra coordination at all. This is the core trick of Diffie-Hellman key exchange: if Alice combines *her* private key with Bob's public key, and Bob combines *his* private key with Alice's public key, they arrive at the exact same shared secret — without ever transmitting it. Both sides derive an AES-256-GCM key this way independently, whenever they open the chat.

**Group chats** can't use that trick directly (there's no single "other" key to combine with). So when a group is created, the browser:

1. Generates one random AES-256-GCM "group key".
2. For every member (including the creator), derives an ECDH shared secret with that member's public key, and uses it to encrypt ("wrap") a copy of the raw group key.
3. Sends only those wrapped copies to the server (`Chat.groupKeyWraps`).

The server stores N encrypted copies of a key it can never open. Each member's browser finds the one copy addressed to them and unwraps it with their own private key.

**Attachments** get the same treatment as text: the file's bytes are encrypted with the chat's key before upload, and so is a small JSON blob containing the real filename and MIME type — the server never learns that a message contains, say, `payroll.pdf`. It just stores ciphertext with a random name and serves it back as opaque bytes on request.

All of this is built on the browser's native `crypto.subtle` — no third-party crypto dependency, nothing that could quietly no-op. The full implementation is about 250 lines of well-commented code across `client/src/crypto/*.js`, deliberately kept small enough to actually read.

## Security model

Being upfront about what this does and doesn't protect against matters more than the word "encrypted" on its own. This is a real, working E2EE implementation — but it is **not** a from-scratch reimplementation of Signal, and it makes some genuine trade-offs for simplicity:

| This has… | This does NOT have (yet)… |
|---|---|
| Real client-side AES-256-GCM + ECDH encryption | **Forward secrecy** — a compromised long-term key exposes every past message encrypted under it, since there's no ratcheting |
| A server that only ever stores/routes ciphertext | **Safety-number / key verification UI** — there's no way to manually confirm someone's public key is really theirs, so a fully compromised, actively malicious server *could* substitute its own public key for someone's and sit in the middle of a conversation. (A passive server that just logs traffic cannot read anything, regardless.) |
| Encrypted attachments (bytes *and* metadata) | **Multi-device sync** — logging in from a new browser generates a *new* key pair. Private chats keep working immediately (keys re-derive from public keys on the fly). Existing group chats will show "unable to decrypt" for messages sent before that point, because the old group key was only ever wrapped for the old key pair. |
| | **Group membership changes** — there's currently no way to add a member to an existing group or to rotate/re-wrap the group key, so removing someone wouldn't revoke their access to a key they already have |
| | **Rate limiting** on login, registration, or message sending |

None of this is hidden in the implementation — see the comments at the top of `client/src/crypto/webcrypto.js` for the same list in context. If you're evaluating this for something beyond a learning project, treat the table above as a literal to-do list, not a footnote.

## How the real-time architecture works

**One login, two transports.** Express sessions are normally only readable by HTTP requests. `server/server.js` creates a single `express-session` middleware instance and uses it twice: once as normal Express middleware, and once wrapped for Socket.IO in `server/sockets/index.js`:

```js
const wrap = (middleware) => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));
```

This lets a socket connection read `socket.request.session.userId` — the same cookie the browser already sent — so there's no separate token or handshake step to log in twice.

**Rooms model "who should hear this."** Each chat's MongoDB `_id` doubles as a Socket.IO room name. When a user connects, their socket joins a room for every chat they belong to, plus a personal `user:<id>` room used for account-wide notifications (like "you were just added to a new group"). Sending a message becomes: save the ciphertext to MongoDB, then `io.to(chatId).emit('new-message', ...)` — every connected participant gets it instantly, including the sender's other open tabs.

**Presence uses reference counting, not just connect/disconnect.** A user can have the app open in multiple tabs. `server/sockets/index.js` keeps an in-memory `Map` of `userId -> Set of socket ids` so a user is only marked offline once their *last* tab disconnects — and it does this from the `disconnecting` event (not `disconnect`), because that's the last moment a socket still knows which rooms it belonged to.

**Typing indicators are deliberately not persisted.** They're pure ephemeral events (`socket.to(chatId).emit('typing', ...)`) with a client-side timeout as a safety net in case a "stop typing" event is ever lost — nothing touches the database for this.

## Notes & possible extensions

- Encrypted attachments are stored on local disk (`server/uploads/`) via Multer — fine for learning/dev; swap in S3/Cloud Storage for production (the ciphertext-at-rest property makes this safe even on untrusted storage).
- There's no read-receipt/unread-count system yet.
- See [Security model](#security-model) above and [SECURITY.md](./SECURITY.md) for what to review before deploying this publicly.

## Contributing

Contributions are welcome — bug reports, feature ideas, docs fixes, and pull requests all count.

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, coding conventions, and the PR workflow.
- Please follow the [Code of Conduct](./CODE_OF_CONDUCT.md) in all project spaces.
- Found a security issue? Please don't file a public issue — see [SECURITY.md](./SECURITY.md) instead.
- Bug reports and feature requests use the templates that come up automatically when you [open an issue](https://github.com/RealUnfazed/unisontalk/issues/new/choose).

## License

Distributed under the [MIT License](./LICENSE). Copyright © Alireza Asakareh (RealUnfazed).

## Author

**Alireza Asakareh** ([RealUnfazed](https://github.com/RealUnfazed))
