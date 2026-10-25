import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AviedoClient } from '../supplier.js';

const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const options = { token: 'test-token', secret: 'test-secret', intervalMs: 0 };

test('signed GET includes the exact encoded query and never follows redirects', async () => {
  let request;
  const client = new AviedoClient({ ...options, now: () => 1792919000000,
    fetchImpl: async (url, init) => { request = { url, init }; return response({ ok: true, data: [] }); } });
  await client.products({ ids: '1,2', in_stock: '1' });
  const path = '/v1/products?ids=1%2C2&in_stock=1';
  assert.equal(request.url, 'https://api.aviedo.net' + path);
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.redirect, 'manual');
  assert.equal(request.init.headers['X-Aviedo-Signature'], createHmac('sha256', 'test-secret')
    .update('1792919000\nGET\n' + path + '\n').digest('hex'));
  assert.ok(request.init.signal);
});

test('read-only client rejects order creation paths and path injection before fetch', async () => {
  let calls = 0;
  const client = new AviedoClient({ ...options, fetchImpl: async () => { calls++; } });
  for (const path of ['/v1/orders', '/v1/products/1?x=y', '//evil.test', '/v1/products/../orders']) {
    await assert.rejects(client.get(path), { code: 'read_path_not_allowed' });
  }
  assert.equal(calls, 0);
  assert.throws(() => client.product('1/../orders'), { code: 'invalid_product_id' });
});

test('credential-bearing redirect is refused', async () => {
  const client = new AviedoClient({ ...options,
    fetchImpl: async () => response({}, 302, { Location: 'https://example.org' }) });
  await assert.rejects(client.balance(), { code: 'redirect_refused' });
});

test('rate limit blocks subsequent requests, without retrying or making purchases', async () => {
  let calls = 0;
  const client = new AviedoClient({ ...options, fetchImpl: async () => {
    calls++;
    return response({ ok: false, error: { code: 'rate_limited', retry_after: 30 } }, 429);
  } });
  await assert.rejects(client.balance(), { code: 'rate_limited' });
  await assert.rejects(client.balance(), { code: 'rate_limited' });
  assert.equal(calls, 1);
});

test('network errors do not include URLs or credentials', async () => {
  const client = new AviedoClient({ ...options, fetchImpl: async () => {
    throw new Error('https://example.test/test-token/test-secret');
  } });
  await assert.rejects(client.balance(), error => error.code === 'network_error' &&
    !error.message.includes('test-token') && !error.message.includes('test-secret'));
});

test('invalid JSON and supplier errors become bounded safe error codes', async () => {
  const invalid = new AviedoClient({ ...options, fetchImpl: async () => new Response('<html>bad</html>') });
  await assert.rejects(invalid.balance(), { code: 'invalid_response' });
  const client = new AviedoClient({ ...options, fetchImpl: async () =>
    response({ ok: false, error: { code: 'invalid_signature', details: 'do not log me' } }, 401) });
  await assert.rejects(client.balance(), error => error.code === 'invalid_signature' && !error.message.includes('do not log me'));
});

test('independent callers are serialized for the common supplier balance', async () => {
  let active = 0, maxActive = 0;
  const client = new AviedoClient({ ...options, fetchImpl: async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return response({ ok: true, data: [] });
  } });
  await Promise.all([client.balance(), client.products(), client.rate()]);
  assert.equal(maxActive, 1);
});
