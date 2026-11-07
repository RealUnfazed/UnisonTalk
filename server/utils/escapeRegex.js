// Turns user text into a literal pattern for MongoDB's $regex, so "a.*" or
// "(a+)+$" search for exactly those characters instead of being executed as
// a pattern (pattern injection / ReDoS).
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { escapeRegex };
