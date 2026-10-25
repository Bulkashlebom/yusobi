import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function cleanupTemp(dir) {
  const target = resolve(dir);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep) && /^ysobi-(app|orphan|entry)-/.test(basename(target)));
  rmSync(target, { recursive: true, force: true });
}

// Real Telegraf + SQLite, with Telegram transport stubbed before importing the app.
test('real app opens an isolated database and handles start/catalog without network', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ysobi-app-'));
  const previous = { DATA_DIR: process.env.DATA_DIR, BOT_TOKEN: process.env.BOT_TOKEN, ADMIN_ID: process.env.ADMIN_ID };
  process.env.DATA_DIR = dir;
  process.env.BOT_TOKEN = '123456789:offline_test_token_1234567890123456';
  process.env.ADMIN_ID = '42';
  const { Telegram } = await import('telegraf');
  const original = Telegram.prototype.callApi;
  const requests = [];
  Telegram.prototype.callApi = async function(method, payload) {
    requests.push({ method, payload });
    if (method === 'getMe') return { id: 123456789, is_bot: true, username: 'YsobiOfflineTest_bot', first_name: 'Test' };
    return { message_id: requests.length, chat: { id: 42, type: 'private' }, date: 1, text: payload?.text || '' };
  };
  let app, database;
  try {
    app = await import('../bot.js');
    database = await import('../db.js');
    assert.ok(database.default.getAllCategories().length > 0, 'new store has its category seeds');
    const from = { id: 42, is_bot: false, first_name: 'Buyer', username: 'offline_buyer' };
    const chat = { id: 42, type: 'private' };
    await app.bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1,
      from, chat, text: '/start', entities: [{ offset: 0, length: 6, type: 'bot_command' }] } });
    const startRequests = requests.filter(request => request.method === 'sendMessage');
    assert.ok(startRequests.some(request => request.payload.reply_markup), 'main menu sent');
    await app.bot.handleUpdate({ update_id: 2, callback_query: { id: 'offline_query', from,
      chat_instance: 'offline', data: 'catalog', message: { message_id: 2, chat, date: 1, text: 'Menu' } } });
    assert.ok(requests.some(request => request.method === 'answerCallbackQuery'));
    assert.equal(requests.some(request => String(request.payload?.text).includes('временная ошибка')), false);
    assert.equal(database.default.getAllOrders().length, 0);
  } finally {
    await app?.stopBot('test');
    database?.db.close();
    Telegram.prototype.callApi = original;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    cleanupTemp(dir);
  }
});

test('orphan SQLite WAL cannot silently become a new empty shop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ysobi-orphan-'));
  try {
    writeFileSync(join(dir, 'shop.db-wal'), 'orphan-test');
    const file = new URL('../db.js', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(file)})`],
      { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WAL found without the main database/);
  } finally { cleanupTemp(dir); }
});

for (const entry of ['bot.js', 'bot-entry.js']) {
  test(`${entry} uses the standalone startup and fails clearly without a token`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ysobi-entry-'));
    try {
      const file = fileURLToPath(new URL('../' + entry, import.meta.url));
      const result = spawnSync(process.execPath, [file], {
        env: { ...process.env, DATA_DIR: dir, BOT_TOKEN: '' },
        encoding: 'utf8', timeout: 10000, cwd: dir,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /BOT_TOKEN is required/);
      assert.equal(result.error, undefined);
    } finally { cleanupTemp(dir); }
  });
}
