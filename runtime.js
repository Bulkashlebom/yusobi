import { setTimeout as sleep } from 'node:timers/promises';
import { safeError } from './config.js';

// Telegraf.launch() resolves when polling STOPS; Telegraf is not an EventEmitter.
// Keep a single launch promise and never wait for a nonexistent `stop` event.
export class BotRuntime {
  constructor(bot, { token, retryMs = 5000, staleMs = 180000,
    now = Date.now, onFatal = () => {}, logger = console } = {}) {
    this.bot = bot;
    this.token = token;
    this.retryMs = retryMs;
    this.staleMs = staleMs;
    this.now = now;
    this.onFatal = onFatal;
    this.logger = logger;
    this.state = 'stopped';
    this.lastPollAt = null;
    this.lastAttemptAt = null;
    this.lastError = null;
    this.runPromise = null;
    this.watchdog = null;
    this.abort = null;
    const original = bot.telegram.callApi.bind(bot.telegram);
    bot.telegram.callApi = async (method, payload, ...args) => {
      if (method === 'getUpdates' && this.abort?.signal.aborted) {
        const error = new Error('Bot stopped');
        error.name = 'AbortError';
        throw error;
      }
      const result = await original(method, payload, ...args);
      if (method === 'getUpdates' && !this.abort?.signal.aborted) {
        this.lastPollAt = this.now();
        this.lastError = null;
        this.state = 'running';
      }
      return result;
    };
  }

  snapshot() {
    const age = this.lastPollAt === null ? null : this.now() - this.lastPollAt;
    return { state: this.state, ready: this.state === 'running' && age < this.staleMs,
      lastPollAt: this.lastPollAt, lastError: this.lastError };
  }

  start() {
    if (this.runPromise) return this.runPromise;
    if (!this.token || this.token === 'DUMMY_TOKEN_NOT_CONFIGURED') {
      this.state = 'disabled';
      return Promise.resolve();
    }
    this.abort = new AbortController();
    this.lastAttemptAt = this.now();
    this.watchdog = setInterval(() => this.checkHealth(), 30000);
    this.watchdog.unref();
    this.runPromise = this.run().finally(() => {
      clearInterval(this.watchdog);
      this.watchdog = null;
      this.runPromise = null;
      if (this.state !== 'failed') this.state = 'stopped';
    });
    return this.runPromise;
  }

  fail(error) {
    if (this.state === 'failed') return;
    this.lastError = safeError(error);
    this.state = 'failed';
    this.stop('fatal');
    this.onFatal(error);
  }

  checkHealth() {
    if (!this.abort || this.abort.signal.aborted) return;
    if (this.now() - (this.lastPollAt ?? this.lastAttemptAt) >= this.staleMs) {
      this.fail(new Error('Telegram polling has not progressed for 180 seconds; restart required'));
    }
  }

  async run() {
    while (!this.abort.signal.aborted) {
      this.state = 'starting';
      try {
        this.logger.info('[BOT] Starting Telegram polling');
        await this.bot.launch({ dropPendingUpdates: false });
      } catch (error) {
        if (this.abort.signal.aborted) break;
        const code = Number(error?.response?.error_code ?? error?.code);
        this.lastError = safeError(error);
        if (code === 401 || code === 404 || code === 409) {
          this.logger.error(code === 409
            ? '[BOT] Another process is using this token. Run exactly one replica.'
            : '[BOT] Telegram rejected BOT_TOKEN. Check the deployment variables.');
          this.fail(error);
          break;
        }
        this.logger.warn('[BOT] Connection error:', this.lastError);
      }
      if (this.abort.signal.aborted) break;
      this.state = 'retrying';
      await sleep(this.retryMs, undefined, { signal: this.abort.signal }).catch(() => {});
    }
  }

  stop(reason = 'shutdown') {
    this.abort?.abort();
    clearInterval(this.watchdog);
    if (this.state !== 'failed') this.state = 'stopping';
    try { this.bot.stop(reason); } catch { /* Still waiting for getMe/deleteWebhook. */ }
    return this.runPromise || Promise.resolve();
  }
}
