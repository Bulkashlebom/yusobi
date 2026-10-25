import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { readEnv, saveEnv } from '../env-file.js';
import { registerOwnerSetup } from '../owner-setup.js';

test('owner pairing requires a private chat, matching unexpired secret, and persists one owner only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ysobi-owner-'));
  const cwd = process.cwd();
  const old = { ...process.env };
  let now = 1000;
  try {
    process.chdir(dir);
    process.env.OWNER_SETUP_SECRET = 'random-private-setup-secret';
    process.env.OWNER_SETUP_EXPIRES = '100000';
    delete process.env.ADMIN_ID; delete process.env.ADMIN_IDS;
    saveEnv({ OWNER_SETUP_SECRET: process.env.OWNER_SETUP_SECRET,
      OWNER_SETUP_EXPIRES: process.env.OWNER_SETUP_EXPIRES, BOT_TOKEN: 'preserved-token' });
    let handler, connected = 0;
    registerOwnerSetup({ command(name, fn) { assert.equal(name, 'connect'); handler = fn; } },
      { getAdminIds: () => process.env.ADMIN_ID ? [process.env.ADMIN_ID] : [],
        now: () => now, onConnected: () => connected++ });
    const replies = [];
    const ctx = (id, code, type = 'private') => ({ from: { id, username: 'test_owner' },
      chat: { id: type === 'private' ? id : -1000, type }, message: { text: '/connect ' + code },
      reply: async message => { replies.push(message); } });
    await handler(ctx(42, process.env.OWNER_SETUP_SECRET, 'group'));
    assert.equal(connected, 0);
    await handler(ctx(42, 'wrong'));
    assert.equal(readEnv().ADMIN_ID, undefined);
    now += 6000;
    await handler(ctx(42, process.env.OWNER_SETUP_SECRET));
    assert.equal(readEnv().ADMIN_ID, '42');
    assert.equal(readEnv().BOT_TOKEN, 'preserved-token');
    assert.equal(readEnv().OWNER_SETUP_SECRET, '');
    assert.equal(readEnv().SUPPORT_CONTACT, '@test_owner');
    assert.equal(connected, 1);
    await handler(ctx(99, 'random-private-setup-secret'));
    assert.equal(readEnv().ADMIN_ID, '42');
    assert.equal(connected, 1);
    assert.equal(replies.some(message => message.includes('random-private-setup-secret')), false);
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
    const target = resolve(dir);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('ysobi-owner-'));
    rmSync(target, { recursive: true, force: true });
  }
});

test('env writer round-trips supported secrets and ignores invalid variable names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ysobi-owner-'));
  try {
    const file = join(dir, '.env');
    saveEnv({ BOT_TOKEN: '1234:abc-DEF_123', DATA_DIR: 'C:/shop/data', INVALID_NAME_WITH_SPACE: 'x',
      'bad key': 'must not be written' }, file);
    assert.equal(readEnv(file).BOT_TOKEN, '1234:abc-DEF_123');
    assert.equal(readEnv(file).DATA_DIR, 'C:/shop/data');
    assert.equal(readEnv(file)['bad key'], undefined);
  } finally {
    const target = resolve(dir);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('ysobi-owner-'));
    rmSync(target, { recursive: true, force: true });
  }
});
