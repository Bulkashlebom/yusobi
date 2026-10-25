import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('local control binds loopback, protects APIs, rejects invalid tokens and stops cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ysobi-control-'));
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../local-control.js', import.meta.url)),
    '--config-dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let exited = false;
  proc.on('exit', () => { exited = true; });
  try {
    const url = await new Promise((resolveUrl, reject) => {
      const timeout = setTimeout(() => reject(new Error('Control startup timed out')), 8000);
      proc.stdout.on('data', data => {
        output += data;
        const match = output.match(/YSOBI_LOCAL_URL=(http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolveUrl(match[1]); }
      });
      proc.on('error', reject);
    });
    const page = await (await fetch(url)).text();
    const key = page.match(/const key="([a-f0-9]{64})"/)[1];
    assert.equal((await fetch(url + '/api/status')).status, 403);
    const headers = { 'X-Local-Key': key, 'Content-Type': 'application/json' };
    const status = await (await fetch(url + '/api/status', { headers })).json();
    assert.equal(status.configured, false);
    assert.equal(JSON.stringify(status).includes('BOT_TOKEN'), false);
    assert.equal((await fetch(url + '/api/status', { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
    const result = await fetch(url + '/api/setup', { method: 'POST', headers, body: JSON.stringify({ token: 'invalid' }) });
    assert.equal(result.status, 400);
    assert.equal(existsSync(join(dir, '.env')), false);
    const exit = once(proc, 'exit');
    assert.equal((await fetch(url + '/api/exit', { method: 'POST', headers, body: '{}' })).status, 200);
    const [code] = await exit;
    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, 'data/local-control.lock')), false);
  } finally {
    if (!exited) proc.kill();
    const target = resolve(dir);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('ysobi-control-'));
    rmSync(target, { recursive: true, force: true });
  }
});
