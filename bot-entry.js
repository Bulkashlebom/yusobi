import './config.js';
import http from 'node:http';
import { safeError } from './config.js';
import db from './db.js';
import { runtime, startBot, stopBot } from './bot.js';
import { healthHandler } from './health.js';

let shuttingDown = false;
let healthServer;
export async function shutdown(code = 0, reason = 'shutdown') {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(code || 1), 10000);
  deadline.unref();
  try {
    await Promise.all([
      stopBot(reason),
      new Promise(resolve => healthServer?.listening ? healthServer.close(resolve) : resolve()),
    ]);
    db.db.close();
  } finally {
    clearTimeout(deadline);
    process.exit(code);
  }
}

runtime.onFatal = error => {
  console.error('[BOT FATAL]', safeError(error));
  const apiCode = Number(error?.response?.error_code ?? error?.code);
  void shutdown(apiCode === 409 ? 73 : apiCode === 401 || apiCode === 404 ? 78 : 1, 'fatal');
};
process.on('message', message => {
  if (message?.type === 'shutdown') void shutdown(0, 'local_stop');
});
process.once('disconnect', () => void shutdown(0, 'parent_disconnected'));
process.once('SIGINT', () => void shutdown(0, 'SIGINT'));
process.once('SIGTERM', () => void shutdown(0, 'SIGTERM'));
process.once('uncaughtException', error => {
  console.error('[FATAL]', safeError(error));
  void shutdown(1, 'uncaughtException');
});
process.once('unhandledRejection', error => {
  console.error('[FATAL]', safeError(error));
  void shutdown(1, 'unhandledRejection');
});

if (!process.env.BOT_TOKEN || process.env.BOT_TOKEN === 'DUMMY_TOKEN_NOT_CONFIGURED') {
  console.error('[CONFIG] BOT_TOKEN is required. Add it to deployment variables.');
  void shutdown(1, 'missing_token');
} else {
  const port = Number(process.env.PORT || 3000);
  healthServer = http.createServer(healthHandler(runtime));
  healthServer.on('error', error => {
    console.error('[HTTP FATAL]', safeError(error));
    void shutdown(1, 'http_error');
  });
  healthServer.listen(port, process.env.HEALTH_HOST || '0.0.0.0', () => {
    console.info(`[HTTP] Health endpoints listening on ${port}`);
    void startBot();
  });
}
