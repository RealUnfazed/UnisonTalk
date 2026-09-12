# UnisonTalk

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-realtime-black?logo=socket.io&logoColor=white)](https://socket.io)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

A real-time chat platform built with **Express, EJS, Socket.IO, and MongoDB**. It covers the core mechanics of building a live, multi-user app on top of WebSockets: shared sessions between HTTP and sockets, presence tracking, typing indicators, and message broadcasting to rooms.

## Table of contents

- [Features](#features)
- [Stack](#stack)
- [Getting started](#getting-started)
- [Project structure](#project-structure)
- [How the real-time architecture works](#how-the-real-time-architecture-works)
- [Notes & possible extensions](#notes--possible-extensions)
- [Contributing](#contributing)
- [License](#license)
- [Author](#author)

## Features

- **Accounts** — register/login with hashed passwords (bcrypt), sessions stored in MongoDB
- **Private & group chats** — start a 1:1 chat by username, or create a named group with multiple members
- **Online status** — presence dots update live as people connect/disconnect, even across multiple tabs
- **Typing indicators** — see when someone in the open chat is typing, in real time
- **Message history** — cursor-paginated; scroll up in a thread to load older messages
- **File/image attachments** — attach a file to any message; images render inline, other files show as a download link

## Stack

Express · EJS · Socket.IO · MongoDB (Mongoose) · Tailwind CSS (CDN) · Font Awesome

## Getting started

**Prerequisites:** Node.js 18+, and a MongoDB instance (local install or a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster).

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

Then open **http://localhost:3000**, register two accounts (e.g. in two different browsers or an incognito window), and start chatting between them to see presence, typing, and live messages in action.

## Project structure

```
config/db.js          MongoDB connection
models/                Mongoose schemas: User, Chat, Message
middleware/auth.js     Session-based route protection + res.locals.currentUser
middleware/upload.js   Multer config for attachment uploads
routes/auth.js         Register / login / logout
routes/chat.js         Chat page + REST API (chats, messages, user search, uploads)
sockets/index.js       All Socket.IO logic (the "real-time" part)
utils/serialize.js     Shapes Mongoose docs into client-friendly JSON
views/                 EJS templates (auth pages + the main chat UI)
public/js/chat.js      Client-side app: socket wiring, rendering, modals
```

## How the real-time architecture works

**One login, two transports.** Express sessions are normally only readable by HTTP requests. `server.js` creates a single `express-session` middleware instance and uses it twice: once as normal Express middleware, and once wrapped for Socket.IO in `sockets/index.js`:

```js
const wrap = (middleware) => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));
```

This lets a socket connection read `socket.request.session.userId` — the same cookie the browser already sent — so there's no separate token or handshake step to log in twice.

**Rooms model "who should hear this."** Each chat's MongoDB `_id` doubles as a Socket.IO room name. When a user connects, their socket joins a room for every chat they belong to, plus a personal `user:<id>` room used for account-wide notifications (like "you were just added to a new group"). Sending a message becomes: save it to MongoDB, then `io.to(chatId).emit('new-message', ...)` — every connected participant gets it instantly, including the sender's other open tabs.

**Presence uses reference counting, not just connect/disconnect.** A user can have the app open in multiple tabs. `sockets/index.js` keeps an in-memory `Map` of `userId -> Set of socket ids` so a user is only marked offline once their *last* tab disconnects — and it does this from the `disconnecting` event (not `disconnect`), because that's the last moment a socket still knows which rooms it belonged to.

**Typing indicators are deliberately not persisted.** They're pure ephemeral events (`socket.to(chatId).emit('typing', ...)`) with a client-side timeout as a safety net in case a "stop typing" event is ever lost — nothing touches the database for this.

## Notes & possible extensions

- Attachments are stored on local disk (`public/uploads/`) via Multer — fine for learning/dev, but swap in S3/Cloud Storage for production.
- There's no read-receipt/unread-count system yet; `Message` documents would need a `readBy` array and some socket events to add one.
- Sessions are stored in MongoDB via `connect-mongo`, so restarting the server doesn't log anyone out.
- See [SECURITY.md](./SECURITY.md) for a few things worth reviewing before deploying this publicly.

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
