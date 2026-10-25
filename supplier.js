import './config.js';
import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export class SupplierError extends Error {
  constructor(code, { status = 0, retryAfter = 0 } = {}) {
    super(`Aviedo: ${code}`);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function signature(secret, timestamp, method, path, body = '') {
  return createHmac('sha256', secret)
    .update(`${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`).digest('hex');
}

// Phase one deliberately exposes only reads. Purchasing is enabled only after
// payment processing, price limits and persistent order reconciliation exist.
export class AviedoClient {
  constructor({ token = process.env.AVIEDO_TOKEN, secret = process.env.AVIEDO_SECRET,
    fetchImpl = fetch, timeoutMs = 12000, intervalMs = 700, now = Date.now } = {}) {
    if (!token || !secret) throw new SupplierError('credentials_missing');
    this.token = token;
    this.secret = secret;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.intervalMs = intervalMs;
    this.now = now;
    this.lastRequest = 0;
    this.blockedUntil = 0;
    this.queue = Promise.resolve();
  }

  get(path, query = {}) {
    if (!/^\/v1\/(?:balance|rate|catalog|products(?:\/[1-9]\d*)?)$/.test(path)) {
      return Promise.reject(new SupplierError('read_path_not_allowed'));
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const signedPath = path + (params.size ? '?' + params.toString() : '');
    const pending = this.queue.then(() => this.request(signedPath));
    this.queue = pending.catch(() => {});
    return pending;
  }

  async request(path) {
    if (this.blockedUntil > this.now()) {
      throw new SupplierError('rate_limited', { status: 429,
        retryAfter: Math.ceil((this.blockedUntil - this.now()) / 1000) });
    }
    const wait = this.lastRequest + this.intervalMs - this.now();
    if (wait > 0) await sleep(wait);
    const timestamp = String(Math.floor(this.now() / 1000));
    this.lastRequest = this.now();
    let response;
    try {
      response = await this.fetch('https://api.aviedo.net' + path, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json',
          'X-Aviedo-Timestamp': timestamp,
          'X-Aviedo-Signature': signature(this.secret, timestamp, 'GET', path),
          'User-Agent': 'YsobiTelegramShop/1.1' },
      });
    } catch { throw new SupplierError('network_error'); }
    if (response.status >= 300 && response.status < 400) {
      throw new SupplierError('redirect_refused', { status: response.status });
    }
    let payload;
    try {
      const text = await response.text();
      if (text.length > 16 * 1024 * 1024) throw new Error('oversize');
      payload = JSON.parse(text);
    } catch { throw new SupplierError('invalid_response', { status: response.status }); }
    if (!response.ok || payload?.ok !== true) {
      const rawCode = payload?.error?.code;
      const code = /^[a-z0-9_]{1,80}$/.test(rawCode || '') ? rawCode : 'http_error';
      const rawRetry = Number(payload?.error?.retry_after || response.headers.get('retry-after') || 30);
      const retryAfter = Number.isFinite(rawRetry) ? Math.max(1, rawRetry) : 30;
      if (response.status === 429) this.blockedUntil = this.now() + retryAfter * 1000;
      throw new SupplierError(code, { status: response.status, retryAfter });
    }
    return payload;
  }

  balance() { return this.get('/v1/balance'); }
  rate() { return this.get('/v1/rate'); }
  products(query) { return this.get('/v1/products', query); }
  catalog() { return this.get('/v1/catalog'); }
  product(id) {
    if (!/^[1-9]\d*$/.test(String(id))) throw new SupplierError('invalid_product_id');
    return this.get(`/v1/products/${id}`);
  }
}
