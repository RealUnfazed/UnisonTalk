# UnisonTalk

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-realtime-black?logo=socket.io&logoColor=white)](https://socket.io)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

A real-time chat platform with a genuinely separated client and server, and two distinct kinds of conversation — the same split Telegram uses:

- **Cloud Chats** (default) — stored server-side, synced instantly across every device the moment you log in. No keys, no setup, no way to lose history by losing a browser.
- **Secret Chats** (opt-in) — genuinely end-to-end encrypted using the browser's native Web Crypto API. The server only ever stores ciphertext. The trade-off, same as real Telegram: these live on the device(s) where you've used them, not your account in general.

```
server/   Express + Socket.IO + MongoDB API, MVC-style. No view layer.
          Cloud Chats: stores/reads plain messages, like any normal chat app.
          Secret Chats: stores ciphertext only — it cannot read these.

client/   Framework-free static JS app (its own model/view/controller split).
          Cloud Chats: sends/receives plain text, no crypto involved.
          Secret Chats: encrypts/decrypts entirely client-side before
          anything touches the network.
```

## Table of contents

- [Features](#features)
- [Stack](#stack)
- [Getting started](#getting-started)
- [Project structure](#project-structure)
- [Cloud Chats vs. Secret Chats](#cloud-chats-vs-secret-chats)
- [How the client/server separation works](#how-the-clientserver-separation-works)
- [How Cloud Chat encryption-at-rest works](#how-cloud-chat-encryption-at-rest-works)
- [How Secret Chat encryption works](#how-secret-chat-encryption-works)
- [Security model](#security-model)
- [How the real-time architecture works](#how-the-real-time-architecture-works)
- [Phasetime SSO (optional)](#phasetime-sso-optional)
- [Notes & possible extensions](#notes--possible-extensions)
- [Contributing](#contributing)
- [License](#license)
- [Author](#author)

## Features

- **Accounts** — register/login with hashed passwords (bcrypt), sessions stored in MongoDB, or sign in with [Phasetime SSO](#phasetime-sso-optional) if configured
- **Cloud Chats** — private chats and groups that just work: log in anywhere, your conversations and files are already there
- **Secret Chats** — opt-in, genuinely end-to-end encrypted 1:1 chats; the server never sees plaintext
- **Online status** — presence dots update live as people connect/disconnect, even across multiple tabs
- **Typing indicators** — see when someone in the open chat is typing, in real time
- **Message history** — cursor-paginated; scroll up in a thread to load older messages
- **File/image attachments** — Telegram-style: filename and size show immediately, images preview inline, one click downloads straight to your browser's normal download flow

## Stack

**Server:** Express · Socket.IO · MongoDB (Mongoose) · express-session (Mongo-backed)
**Client:** Vanilla JavaScript (ES modules, no bundler) · Web Crypto API (Secret Chats only) · Tailwind CSS (CDN) · Font Awesome

## Getting started

**Prerequisites:** Node.js 18+, and a MongoDB instance (local install or a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster). Secret Chats need a reasonably modern evergreen browser (Chrome, Firefox, Safari, or Edge) for the Web Crypto API and IndexedDB — Cloud Chats work anywhere.

```bash
# 1. Clone the repo
git clone https://github.com/RealUnfazed/unisontalk.git
cd unisontalk

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# then edit .env: set MONGODB_URI, a random SESSION_SECRET, and
# CLOUD_ENCRYPTION_KEY (a 64-char hex string — .env.example shows how to
# generate one). The server won't start without a valid encryption key.

# 4. Run it
npm run dev      # with nodemon, auto-restarts on changes
# or
npm start
```

Then open **http://localhost:3000**, register two accounts (e.g. in two different browsers or an incognito window), and start chatting between them. Try a normal chat first, then use the "New secret chat" option in the **+** menu to see the encrypted flow.

## Project structure

```
server/
  server.js              Entry point: connects MongoDB, starts HTTP + Socket.IO
  app.js                 Express app config — CORS, sessions, routes, static serving
  config/db.js           MongoDB connection
  config/phasetime.js    Phasetime SSO config (returns null if unconfigured — feature is optional)
  models/                Mongoose schemas: User, Chat (isGroup/isSecret), Message
  controllers/           Request handlers — auth, chats/messages, uploads, Phasetime SSO
  routes/                Route definitions, wired to controllers
  middleware/             Session-based auth guard, Multer upload config
  sockets/index.js        All Socket.IO logic — branches on chat.isSecret
  utils/serialize.js      Shapes Mongoose docs into client-friendly JSON
  utils/fieldCrypto.js    Cloud Chat encryption-at-rest (AES-256-GCM, server-held key)
  utils/chatPopulate.js   Shared Chat query population spec
  utils/chatVisibility.js Shared "should this chat show in my list yet" rule
  uploads/                Attachment files (plain for Cloud, ciphertext for Secret)

client/
  public/                 Static HTML shells: index.html, login.html, register.html, 404.html
  src/
    crypto/               webcrypto.js (ECDH+AES-GCM primitives), keyStore.js (IndexedDB
                           persistence), identity.js, chatKeys.js — the Secret Chat
                           implementation. Cloud Chats never import any of this.
    models/AppState.js    Client-side state + a small pub/sub mechanism
    views/                Pure rendering: SidebarView, ChatView, ModalView
    controllers/           ChatController — wires sockets, the API, crypto (when
                           needed), and views together; the isSecret branch point
    pages/                Per-page bootstrap scripts (chatPage, loginPage, registerPage,
                           ssoStatus.js shared by the auth pages)
    api.js, socket.js, config.js   Thin wrappers around fetch / Socket.IO / base URLs
```

## Cloud Chats vs. Secret Chats

Every 1:1 chat is one or the other; groups are always Cloud Chats (see [Security model](#security-model) for why).

| | Cloud Chat (default) | Secret Chat (opt-in) |
|---|---|---|
| Where messages live | MongoDB, encrypted at rest with a server-held key (the app can still read/process them — see [Security model](#security-model)) | MongoDB, as ciphertext the server has no key for at all |
| Available on a new device? | Yes — log in, it's there | No — tied to the device(s) it's been used on |
| Setup required | None | None to *use* — a key is generated automatically the first time you open one |
| Groups? | Yes | No (1:1 only — see below) |
| Good for | Everyday conversations | Anything where you specifically don't want it recoverable from the server |

Starting a Secret Chat requires the other person to have opened one before (so their public key is on file) — if they haven't, you'll be told to ask them to start one with you first.

## How the client/server separation works

The server is a **pure JSON + WebSocket API** — there's no `res.render()` anywhere in it, and no template engine. The client is a **fully static app**: plain HTML files plus ES modules, no build step (`<script type="module">` handles the model/view/controller split natively in the browser).

By default, `server/app.js` also serves `client/` as static files, so `npm run dev` gives you one command and one running process. But nothing in the client actually depends on that:

- `client/src/config.js` exports `API_BASE_URL` / `SOCKET_URL`. Point these at a different host and the client works talking to a server running anywhere else.
- The server has CORS enabled (`server/app.js`) and reflects the request's origin with `credentials: true` by default, so a client served from a different port or domain during development just works. Set `ALLOWED_ORIGIN` in `.env` to lock this down before deploying.

## How Cloud Chat encryption-at-rest works

Cloud Chats aren't end-to-end encrypted — the server genuinely needs to read them to do its job (search, moderation, cross-device sync without any client-side key). But "the server can read it" doesn't have to mean "anyone who steals a copy of the database can read it too."

`server/utils/fieldCrypto.js` encrypts message text and attachment filenames with AES-256-GCM before they're written to MongoDB, and decrypts them again — once, in `utils/serialize.js` — on the way back out to the API. The key (`CLOUD_ENCRYPTION_KEY`) lives only in the server's environment, never in the database itself. That split is the whole point: a database dump, a stolen backup, or leaked DB credentials are a *different* failure than a leaked environment variable, so getting one doesn't automatically hand over the other.

What this protects against: someone getting a copy of your MongoDB data (a backup, a dump, an unsecured database exposed to the internet) without also getting your server's environment.

What it doesn't protect against: a compromised, running server process — which has the key loaded in memory to do its job — or anyone with direct access to that environment. That's an inherent limit of any system where the server needs to process the content, not a bug specific to this implementation; it's the same trade-off full-disk encryption or a cloud provider's KMS makes. If a conversation needs to be unreadable even to a fully compromised server, that's what Secret Chats are for.

One practical consequence worth knowing: losing `CLOUD_ENCRYPTION_KEY`, or changing it, makes existing Cloud Chat messages permanently unreadable (there's graceful handling so the app doesn't crash — it shows `[This message could not be decrypted]` instead — but the data is genuinely gone). Back this key up somewhere durable once there's real data behind it.

## How Secret Chat encryption works

Only Secret Chats touch any of this — Cloud Chats never call `client/src/crypto/*` at all.

The first time a person opens or starts a Secret Chat, their browser generates a long-term **ECDH key pair** (P-256 curve) via `crypto.subtle.generateKey`. Only the **public** half is ever sent to the server (`POST /api/auth/keys`) — stored in `User.publicKey` as a simple directory, the same way an email server stores addresses. The private key is generated, used, and persisted (in IndexedDB) entirely client-side and never crosses the network in any form.

This is deliberately **lazy**: an account that never opens a Secret Chat never generates a key, never uploads a public key, and pays none of this cost. Registration and login stay exactly as fast either way.

From there, encrypting a message is the core trick of Diffie-Hellman key exchange: Alice combines *her* private key with Bob's public key, and Bob combines *his* private key with Alice's public key — they arrive at the exact same shared secret without ever transmitting it. Both sides derive an AES-256-GCM key this way independently, whenever they open the chat. Attachments get the same treatment: the file's bytes *and* a small JSON blob holding its real filename/type are both encrypted client-side before upload, so the server genuinely can't tell what a file is, just that ciphertext of *some* size exists.

All of this is built on the browser's native `crypto.subtle` — no third-party crypto dependency, nothing that could quietly no-op. The full implementation is in `client/src/crypto/*.js`, deliberately kept small enough to actually read.

**Key persistence, and why it's stored the way it is:** the identity key pair is cached in IndexedDB as *exported, portable bytes* (PKCS8 for the private key, SPKI for the public key — see `crypto/keyStore.js`), not as a raw `CryptoKey` object. Browsers can store a `CryptoKey` directly via structured-clone support, but that's a newer capability with an unforgiving failure mode here: if it silently doesn't round-trip, the app would quietly generate a new identity on every visit, permanently breaking decryption of everything encrypted under the old one — with no error, since ECDH derivation doesn't "fail" for a wrong key, it just produces a different one. Exporting to plain, portable bytes sidesteps that risk entirely.

## Security model

| Cloud Chats | Secret Chats |
|---|---|
| **Encrypted at rest** with a server-held key (`CLOUD_ENCRYPTION_KEY`, see `server/utils/fieldCrypto.js`) — the server still processes them normally (that's what makes "log in anywhere, see everything" possible with zero client-side key management), but a raw database dump, stolen backup, or leaked DB credentials yield ciphertext, *provided the encryption key wasn't also exposed* — it deliberately lives only in the environment, never in the database. This does not protect against a fully compromised, running server process, which has the key loaded to do its job — same trade-off as disk encryption or any server-side KMS. | Server and database only ever hold ciphertext, and the server never has the key *at all*, not even in memory. A full database compromise or legal request for stored data does not expose Secret Chat contents, full stop — there's no key on the server side to also compromise. |

For Secret Chats specifically, being upfront about what the encryption does and doesn't protect against matters more than the phrase "end-to-end encrypted" on its own:

| Secret Chats have… | Secret Chats do NOT have (yet)… |
|---|---|
| Real client-side AES-256-GCM + ECDH encryption | **Forward secrecy** — a compromised long-term key exposes every past message encrypted under it, since there's no ratcheting |
| A server that only ever stores/routes ciphertext | **Safety-number / key verification UI** — no way to manually confirm someone's public key is really theirs, so a fully compromised, actively malicious server *could* in principle substitute its own key and sit in the middle of a conversation. (A passive server that just logs traffic cannot read anything, regardless.) |
| Encrypted attachments (bytes *and* metadata) | **Group support** — there's no single "other party" to Diffie-Hellman with in a group, so real E2EE groups need per-member key distribution (Signal's "sender keys," or similar); out of scope here, groups are Cloud Chats only |
| Device-local keys, generated lazily, no setup friction | **Multi-device sync for Secret Chats specifically** — a new browser gets a new key, and Secret Chats from before that point won't decrypt there. This mirrors Telegram's own Secret Chats exactly, and does not affect Cloud Chats at all. |

None of this is hidden in the implementation — see the comments at the top of `client/src/crypto/webcrypto.js` for the same list in context.

## How the real-time architecture works

**One login, two transports.** Express sessions are normally only readable by HTTP requests. `server/server.js` creates a single `express-session` middleware instance and uses it twice: once as normal Express middleware, and once wrapped for Socket.IO in `server/sockets/index.js`:

```js
const wrap = (middleware) => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));
```

This lets a socket connection read `socket.request.session.userId` — the same cookie the browser already sent — so there's no separate token or handshake step to log in twice.

**Rooms model "who should hear this."** Each chat's MongoDB `_id` doubles as a Socket.IO room name. When a user connects, their socket joins a room for every chat they belong to, plus a personal `user:<id>` room used for account-wide notifications (like "you were just added to a new group"). Sending a message becomes: save it to MongoDB (plain for Cloud, ciphertext for Secret), then `io.to(chatId).emit('new-message', ...)` — every connected participant gets it instantly, including the sender's other open tabs.

**Presence uses reference counting, not just connect/disconnect.** A user can have the app open in multiple tabs. `server/sockets/index.js` keeps an in-memory `Map` of `userId -> Set of socket ids` so a user is only marked offline once their *last* tab disconnects — and it does this from the `disconnecting` event (not `disconnect`), because that's the last moment a socket still knows which rooms it belonged to.

**Typing indicators are deliberately not persisted.** They're pure ephemeral events (`socket.to(chatId).emit('typing', ...)`) with a client-side timeout as a safety net in case a "stop typing" event is ever lost — nothing touches the database for this.

## Phasetime SSO (optional)

UnisonTalk can optionally support signing in via [Phasetime SSO](https://github.com/RealUnfazed/Phasetime-SSO), an open-source, self-hostable single sign-on server — either the public instance at `account.unfazed.ir` or your own deployment of the same software. It's a standard OAuth2 Authorization Code flow, so this is a normal OAuth client integration, not anything Phasetime-specific under the hood.

**It's entirely optional.** Leave `PHASETIME_SSO_BASE_URL`, `PHASETIME_CLIENT_ID`, `PHASETIME_CLIENT_SECRET`, and `PHASETIME_REDIRECT_URI` unset in `.env` and the feature simply doesn't appear — no "Continue with Phasetime" button, no forced setup, nothing else in the app depends on it. `server/config/phasetime.js` returning `null` when any of those four are missing is what every SSO route checks before doing anything.

### Setup

1. Register this app as a client in your Phasetime instance's admin panel to get a client ID and secret.
2. Set the four `PHASETIME_*` variables in `.env` — see `.env.example` for the exact names and a walkthrough.
3. **`PHASETIME_REDIRECT_URI` must match what's registered in Phasetime's admin panel exactly, byte for byte** — this is a security requirement of the SSO server itself (prevents a stolen authorization code from being redeemed against a different URL), not a UnisonTalk quirk.

### How it works

- `GET /api/auth/sso/phasetime` — starts a login/signup attempt: generates a random `state` value (stored in the session, for CSRF protection), then redirects the browser to Phasetime's `/authorize.php`.
- `GET /api/auth/sso/phasetime/callback` — Phasetime redirects back here with a one-time `code`. The server exchanges it for an access token via a server-to-server `POST /token.php` call (the only place `PHASETIME_CLIENT_SECRET` is ever used — it never reaches the browser), then fetches `{ id, name, email }` from `/userinfo.php`.
- If a local account is already linked to that Phasetime `id`, that account gets signed in. Otherwise, a new account is created automatically, with a username derived from the Phasetime profile's display name (sanitized to fit UnisonTalk's username rules, with a numeric suffix appended if there's a collision) and no local password at all — signing in with a plain username/password is simply never possible for an account that was never given one, without needing a special "SSO-only" flag anywhere.
- **Existing accounts can link a Phasetime identity** instead of creating a duplicate: `GET /api/auth/sso/phasetime/link` (only reachable while already logged in) runs the same OAuth round trip, but attaches the resulting Phasetime ID to the *current* account instead of creating or looking up a new one. There's a "Link Phasetime account" button for this in the sidebar (next to logout) whenever SSO is configured; it switches to "Unlink" once linked.
- If a fresh sign-in's Phasetime email matches an *existing, unlinked* local account, UnisonTalk deliberately does **not** auto-merge them — that's exactly the kind of assumption that fails quietly and unpredictably (email verification guarantees vary, and typo-squatted or previously-abandoned addresses exist). It shows a clear message instead, telling the person to log in normally and link explicitly.

None of this touches Cloud vs. Secret Chats — a Phasetime-authenticated account works exactly like a normal one everywhere else in the app once signed in.

## Notes & possible extensions

- Cloud Chat attachments and Secret Chat ciphertext both live on local disk (`server/uploads/`) via Multer — fine for learning/dev; swap in S3/Cloud Storage for production.
- There's no read-receipt/unread-count system yet.
- There's no way to add a member to an existing group or change a group's membership after creation.
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
