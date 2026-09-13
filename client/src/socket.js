import { SOCKET_URL } from './config.js';

// The classic Socket.IO client script (loaded via a plain <script> tag in
// each page, see client/public/*.html) attaches the `io` function to
// `window`. We wrap it here so the rest of the app can `import { connectSocket }`
// like any other module instead of reaching for a global.
export function connectSocket() {
  return window.io(SOCKET_URL || undefined, { withCredentials: true });
}
