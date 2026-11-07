const { io: connect } = require('socket.io-client');

function connectSocket(url, cookie) {
  return new Promise((resolve, reject) => {
    const socket = connect(url, { transports: ['websocket'], extraHeaders: { cookie }, forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

// Resolves with the payload of the next `event`, or rejects after `ms`.
const nextEvent = (socket, event, ms = 2000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

// Resolves if `event` does NOT arrive within `ms`; rejects if it does.
const noEvent = (socket, event, ms = 400) =>
  new Promise((resolve, reject) => {
    const handler = (payload) => {
      clearTimeout(timer);
      reject(new Error(`unexpected "${event}": ${JSON.stringify(payload)}`));
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, ms);
    socket.once(event, handler);
  });

const emitAck = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

module.exports = { connectSocket, nextEvent, noEvent, emitAck };
