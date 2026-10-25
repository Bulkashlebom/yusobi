import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { BotRuntime } from '../runtime.js';
import { healthHandler } from '../health.js';

const quiet = { info() {}, warn() {}, error() {} };
function fakeBot(errors = []) {
  return {
    calls: [], stops: 0, resolveLaunch: null,
    telegram: { callApi: async () => [] },
    async launch(options) {
      this.calls.push(options);
      const error = errors.shift();
      if (error) throw error;
      await this.telegram.callApi('getUpdates', { timeout: 50 });
      await new Promise(resolve => { this.resolveLaunch = resolve; });
    },
    stop() { this.stops++; this.resolveLaunch?.(); },
  };
}
async function waitFor(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await sleep(2);
  }
  throw new Error('Timed out waiting for runtime');
}

test('launch is single-instance, preserves updates, readiness tracks getUpdates', async () => {
  const bot = fakeBot();
  const runtime = new BotRuntime(bot, { token: 'test', logger: quiet });
  const run = runtime.start();
  assert.equal(runtime.start(), run);
  await waitFor(() => runtime.snapshot().ready);
  assert.deepEqual(bot.calls, [{ dropPendingUpdates: false }]);
  await runtime.stop();
  await run;
  assert.equal(bot.calls.length, 1);
  assert.equal(runtime.state, 'stopped');
});

test('unexpected polling completion reconnects without an EventEmitter stop event', async () => {
  const bot = fakeBot();
  const runtime = new BotRuntime(bot, { token: 'test', logger: quiet, retryMs: 1 });
  const run = runtime.start();
  await waitFor(() => bot.resolveLaunch);
  bot.resolveLaunch();
  await waitFor(() => bot.calls.length === 2);
  await runtime.stop();
  await run;
  assert.equal(bot.calls.length, 2);
});

test('startup network failure retries and recovers', async () => {
  const bot = fakeBot([new Error('ECONNRESET')]);
  const runtime = new BotRuntime(bot, { token: 'test', logger: quiet, retryMs: 1 });
  const run = runtime.start();
  await waitFor(() => runtime.snapshot().ready);
  assert.equal(bot.calls.length, 2);
  await runtime.stop();
  await run;
});

for (const code of [401, 409]) {
  test(`Telegram ${code} stops with an actionable fatal error`, async () => {
    const error = Object.assign(new Error('rejected'), { response: { error_code: code } });
    const bot = fakeBot([error]);
    let fatalCalls = 0;
    const runtime = new BotRuntime(bot, { token: 'test', logger: quiet,
      onFatal: () => fatalCalls++ });
    await runtime.start();
    assert.equal(fatalCalls, 1);
    assert.equal(bot.calls.length, 1);
    assert.equal(runtime.state, 'failed');
  });
}

test('watchdog detects stalled polling, triggers once, no replacement poller in process', async () => {
  let now = 1000;
  let fatals = 0;
  const bot = fakeBot();
  const runtime = new BotRuntime(bot, { token: 'test', now: () => now,
    logger: quiet, onFatal: () => fatals++ });
  const run = runtime.start();
  await waitFor(() => runtime.snapshot().ready);
  now += 180001;
  assert.equal(runtime.snapshot().ready, false);
  runtime.checkHealth();
  runtime.checkHealth();
  await run;
  assert.equal(fatals, 1);
  assert.equal(bot.calls.length, 1);
  assert.equal(runtime.state, 'failed');
});

test('shutdown interrupts reconnect delay', async () => {
  const bot = fakeBot([new Error('network')]);
  const runtime = new BotRuntime(bot, { token: 'test', retryMs: 60000, logger: quiet });
  const run = runtime.start();
  await waitFor(() => runtime.state === 'retrying');
  await runtime.stop();
  await run;
  assert.equal(bot.calls.length, 1);
});

test('missing token does not launch or start watchdog', async () => {
  const bot = fakeBot();
  const runtime = new BotRuntime(bot, { logger: quiet });
  await runtime.start();
  assert.equal(runtime.state, 'disabled');
  assert.equal(runtime.watchdog, null);
  assert.equal(bot.calls.length, 0);
});

test('public health distinguishes live process and ready polling without leaking errors', () => {
  const handler = healthHandler({ snapshot: () => ({ state: 'failed', ready: false,
    lastPollAt: null, lastError: 'secret-value' }) });
  const response = { writeHead(code) { this.code = code; }, end(body) { this.body = body; } };
  handler({ url: '/ready' }, response);
  assert.equal(response.code, 503);
  assert.equal(response.body.includes('secret-value'), false);
  handler({ url: '/health' }, response);
  assert.equal(response.code, 200);
  assert.equal(JSON.parse(response.body).status, 'degraded');
});
