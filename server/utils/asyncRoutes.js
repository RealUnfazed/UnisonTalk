// Express 4 doesn't catch rejected promises from async handlers: an
// unexpected DB error or a TypeError from odd input becomes an unhandled
// rejection, which on modern Node CRASHES THE PROCESS (and hangs the
// request). Wrapping every controller function routes those into Express's
// error middleware instead (see app.js), which logs and answers with a 500.
function wrap(controller) {
  const wrapped = {};
  for (const [name, fn] of Object.entries(controller)) {
    wrapped[name] =
      typeof fn === 'function' ? (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next) : fn;
  }
  return wrapped;
}

module.exports = { wrap };
