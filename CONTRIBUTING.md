# Contributing to UnisonTalk

First off, thanks for considering a contribution — whether that's a bug report, a new feature, or a docs fix. This project is also meant as a learning reference for real-time architecture, so clear, well-commented contributions are especially welcome.

## Code of Conduct

This project follows a [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you're expected to uphold it.

## Ways to contribute

- **Report a bug** — open an [issue](https://github.com/RealUnfazed/unisontalk/issues/new/choose) using the bug report template.
- **Suggest a feature** — open an issue using the feature request template. It's fine if it's a rough idea; discussion helps shape it.
- **Submit a fix or feature** — see the workflow below.
- **Improve the docs** — README clarity, code comments, and setup instructions all count.

## Development setup

1. Fork the repo and clone your fork:
   ```bash
   git clone https://github.com/<your-username>/unisontalk.git
   cd unisontalk
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the environment template and configure it:
   ```bash
   cp .env.example .env
   ```
   You'll need a MongoDB instance — a local install or a free [Atlas](https://www.mongodb.com/atlas) cluster both work.
4. Run the app in dev mode (auto-restarts on save):
   ```bash
   npm run dev
   ```
5. Open two browser sessions (or one normal + one incognito) and register two accounts so you can actually exercise real-time behavior — presence, typing, and live messages only show up with two participants.

## Making changes

1. Create a branch off `main`:
   ```bash
   git checkout -b fix/short-description
   ```
2. Keep changes focused. A PR that fixes one bug or adds one feature is much easier to review than one that does five things.
3. Match the existing style:
   - CommonJS (`require`/`module.exports`), not ESM.
   - Async/await over raw promise chains.
   - Comments should explain *why*, not restate *what* the code does — the existing files (especially `sockets/index.js`) are a good reference.
4. If you touch the data model (`models/`) or the socket events (`sockets/index.js`), double check both the server and client (`public/js/chat.js`) side of the change — the two are easy to get out of sync.
5. There's no automated test suite yet (see "Good first issues" below if you'd like to help with that). At minimum, run the app locally and manually verify your change.
6. Before opening a PR, sanity-check any `.js` file you touched:
   ```bash
   node --check path/to/file.js
   ```

## Commit messages

Keep them short and in the imperative mood ("Add typing indicator timeout", not "Added" or "Adds"). Reference an issue number if there is one (`Fixes #12`).

## Submitting a pull request

1. Push your branch and open a PR against `main`.
2. Fill out the PR template — what changed, why, and how you tested it.
3. Be responsive to review feedback. It's normal to go a couple rounds on a PR; it's not a reflection on the idea, just on getting the implementation solid.

## Good first issues

If you're looking for a place to start, these are areas the project could use help with:

- A read-receipt / unread-count system (`Message` would need a `readBy` array, plus a socket event or two)
- Swapping local-disk attachment storage for S3-compatible storage
- An automated test suite (currently none exists)
- Accessibility passes on the chat UI (keyboard navigation, screen reader labels)
- Rate limiting on login/register/message-sending

Check the [issues page](https://github.com/RealUnfazed/unisontalk/issues) for anything labeled `good first issue` or `help wanted`.

## Reporting security issues

Please don't open a public issue for security vulnerabilities — see [SECURITY.md](./SECURITY.md) instead.

## Questions?

Open a [discussion](https://github.com/RealUnfazed/unisontalk/discussions) or a plain issue — no question is too small.
