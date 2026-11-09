// Empty string = same origin the client was served from. Point this at a
// full URL (e.g. 'https://api.example.com') if the client is ever hosted
// separately from the server — nothing else in the client needs to change.
export const API_BASE_URL = '';
export const SOCKET_URL = ''; // '' lets socket.io-client default to same-origin
// Behind a load balancer WITHOUT sticky sessions, set this to ['websocket'] (and the
// server's SOCKET_TRANSPORTS=websocket): Socket.IO's default long-polling handshake
// makes several HTTP requests that must all reach the same instance.
export const SOCKET_TRANSPORTS = null;
