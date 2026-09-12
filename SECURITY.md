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

- Session cookies and file uploads are configured for local development by default (see `.env.example` and `middleware/upload.js`). Review cookie `secure`/`sameSite` settings and upload storage (local disk vs. object storage) before deploying publicly.
- There's no built-in rate limiting on login, registration, or message sending.
- Uploaded files are validated by MIME type and size, but are served directly from `public/uploads/` — consider a dedicated storage service with stricter access controls for production.
