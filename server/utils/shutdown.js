const logger = require('./logger');

// Runs `steps` in order when asked to stop, with an overall deadline. Each
// step is { name, run }; a failing step is logged and the rest still run, so
// one stuck dependency can't stop the process from exiting.
function createShutdown({ steps, timeoutMs = 10_000, exit = process.exit }) {
  let started = false;
  return async function shutdown(signal) {
    if (started) return; // a second SIGTERM must not restart the sequence
    started = true;
    logger.info(`[shutdown] ${signal} received — shutting down`);

    const deadline = setTimeout(() => {
      logger.error(`[shutdown] still running after ${timeoutMs}ms — forcing exit`);
      exit(1);
    }, timeoutMs);
    deadline.unref();

    let failed = false;
    for (const { name, run } of steps) {
      try {
        await run();
        logger.info(`[shutdown] ${name}: done`);
      } catch (err) {
        failed = true;
        logger.error(`[shutdown] ${name} failed:`, err.message);
      }
    }
    clearTimeout(deadline);
    exit(failed ? 1 : 0);
  };
}

function installSignalHandlers(shutdown, proc = process) {
  for (const signal of ['SIGTERM', 'SIGINT']) proc.on(signal, () => shutdown(signal));
}

module.exports = { createShutdown, installSignalHandlers };
