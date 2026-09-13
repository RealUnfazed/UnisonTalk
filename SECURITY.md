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

- **Read the "Security model" section in [README.md](./README.md) first.** It's a disclosed, honest list of what the end-to-end encryption does and doesn't protect against (no forward secrecy, no safety-number verification, no multi-device sync, no group re-keying on membership changes). None of this is a secret bug — it's documented scope.
- Encryption/decryption happen entirely client-side. The server (`server/`) and MongoDB only ever store ciphertext — this means a database compromise or a subpoena for stored data does not expose message contents, but a **compromised client** (malicious browser extension, XSS, a device someone already has physical access to) exposes exactly what that user could already read, same as any E2EE app.
- Session cookies are configured for local development by default (see `.env.example` and `server/app.js`). Review the cookie `secure`/`sameSite` settings and set `ALLOWED_ORIGIN` before deploying publicly.
- There's no built-in rate limiting on login, registration, or message sending.
- Encrypted attachments are served directly from `server/uploads/` (see `server/middleware/upload.js`) — this is lower-risk than it would be for an unencrypted app, since what's on disk is ciphertext, but you'd still want a dedicated storage service with proper access controls and backup/retention policies for production.
