# Security Policy

## Supported Versions

UnisonTalk doesn't yet follow a formal versioning/release cycle. Security
fixes are applied to the `main` branch — please make sure you're running the
latest commit before reporting an issue.

## Reporting a Vulnerability

**Please don't open a public GitHub issue for security vulnerabilities.**

Instead, report it privately using one of these methods:

1. **Preferred:** open a [private security advisory](https://github.com/RealUnfazed/unisontalk/security/advisories/new) on GitHub.
2. Or contact the maintainer, Alireza Asakareh (RealUnfazed), directly through the contact details on the [GitHub profile](https://github.com/RealUnfazed).

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce it (a minimal example is ideal)
- Any suggested fix, if you have one

You should expect an initial response within a few days. Once a fix is
available, it'll be released and you'll be credited in the release notes
unless you'd prefer otherwise.

## Scope notes

A few things worth knowing if you're evaluating this project for production use, since it started as a learning/reference implementation:

- **This app has two kinds of conversation with very different guarantees — Cloud Chats and Secret Chats.** See the "Cloud Chats vs. Secret Chats" and "Security model" sections in [README.md](./README.md) before assuming anything about what's protected. Cloud Chats (the default) are encrypted at rest with a server-held key (`CLOUD_ENCRYPTION_KEY` — see `server/utils/fieldCrypto.js`) but fully readable by the running application, same as Slack or Discord — that's expected, not a bug, and it's what makes cross-device sync work with no client-side key. Only Secret Chats are end-to-end encrypted, where the server has no key at all, and that comes with its own disclosed, honest list of limits (no forward secrecy, no safety-number verification, no multi-device sync, no group support). None of this is hidden — it's documented scope.
- **`CLOUD_ENCRYPTION_KEY` must be generated and kept safe before deploying with real data.** It's what makes a MongoDB dump alone insufficient to read Cloud Chat messages — but losing it, or committing it to source control alongside your database backups, defeats the purpose entirely. Keep it in a proper secrets manager for anything beyond local development, and back it up somewhere durable: losing the key makes existing Cloud Chat messages permanently unreadable, with no recovery path.
- For Secret Chats, encryption/decryption happen entirely client-side. The server (`server/`) and MongoDB never have the key for these at all — a database compromise or a subpoena for stored data does not expose Secret Chat contents, regardless of what else is compromised on the server. It also doesn't protect against a **compromised client** (malicious browser extension, XSS, a device someone already has physical access to), which exposes exactly what that user could already read, same as any E2EE app.
- Session cookies are configured for local development by default (see `.env.example` and `server/app.js`). Review the cookie `secure`/`sameSite` settings and set `ALLOWED_ORIGIN` before deploying publicly.
- There's no built-in rate limiting on login, registration, or message sending.
- Attachment *files* are served directly from `server/uploads/` (see `server/middleware/upload.js`) — Secret Chat attachment bytes are ciphertext there and are fetched via a JSON API rather than a direct file URL (see the README's Secret Chat section for why), but the files themselves aren't encrypted at rest the way message text and filenames are. Cloud Chat attachment files are plain there too. Either way, you'd want a dedicated storage service with proper access controls and backup/retention policies for production.
