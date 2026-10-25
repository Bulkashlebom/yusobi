import { createHmac } from 'node:crypto';
import { safeError } from './config.js';

export function bridgeSignature(key, timestamp, method, path, body) {
  return createHmac('sha256', key).update(`${timestamp}\n${method}\n${path}\n${body}`).digest('hex');
}

const labels = { new: 'Получена', in_review: 'Проверяем детали', offer_ready: 'Есть ответ продавца', closed: 'Закрыта' };
const uuid = /^[a-f0-9-]{36}$/i;
export class SiteBridge {
  constructor({ url, key, database, telegram, adminIds, isAdmin, fetchImpl = fetch, intervalMs = 25000, allowLocal = false, logger = console }) {
    this.url = url ? new URL(url) : null;
    if (this.url && (this.url.protocol !== 'https:' && !(allowLocal && this.url.hostname === '127.0.0.1'))) throw Error('Shop URL must use HTTPS');
    this.key = key;
    this.database = database;
    this.telegram = telegram;
    this.adminIds = adminIds;
    this.isAdmin = isAdmin;
    this.fetch = fetchImpl;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.pendingReply = new Map();
    this.active = false;
    this.timer = null;
    database.exec('CREATE TABLE IF NOT EXISTS site_deliveries (event_id TEXT NOT NULL, recipient TEXT NOT NULL, delivered_at INTEGER NOT NULL, PRIMARY KEY (event_id, recipient))');
  }
  get enabled() { return Boolean(this.url && this.key); }
  async call(path, payload) {
    if (!this.enabled) throw Error('Магазин пока не подключён.');
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await this.fetch(new URL(path, this.url), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'X-Shop-Timestamp': timestamp,
        'X-Shop-Signature': bridgeSignature(this.key, timestamp, 'POST', path, body) }, body,
    });
    if (!response.ok) throw Error(`Магазин временно недоступен (${response.status}). Повтори позднее.`);
    return response.json();
  }
  async deliver(event, recipient, text, extra = {}) {
    if (this.database.prepare('SELECT 1 FROM site_deliveries WHERE event_id = ? AND recipient = ?').get(event.eventId, recipient)) return;
    try { await this.telegram.sendMessage(recipient, text, extra); }
    catch (error) {
      // A blocked/deleted customer cannot receive future notifications. Do not stall the queue.
      if (!(event.kind === 'customer_update' && [400,403].includes(Number(error?.response?.error_code)))) throw error;
    }
    this.database.prepare('INSERT OR IGNORE INTO site_deliveries VALUES (?, ?, ?)').run(event.eventId, recipient, Date.now());
  }
  async sync() {
    if (!this.enabled || this.busy) return;
    this.busy = true;
    try {
      const data = await this.call('/api/bridge/sync', { acknowledged: this.acknowledged || [] });
      this.acknowledged = [];
      for (const event of data.events || []) {
        if (!uuid.test(event.id) || typeof event.eventId !== 'string') continue;
        if (event.kind === 'new_request') {
          const text = `Новая заявка ${event.reference}\n\n${event.productName}\nКоличество: ${event.quantity}\nОриентир: ${event.estimateRub} ₽ (не оплачено)\nКонтакт: ${event.customer.contact}\nКомментарий: ${event.customer.note || '—'}\n\nСначала согласуй цену, наличие и способ оплаты. Покупка у поставщика автоматически не выполняется.`;
          const inline_keyboard = [[{text:'В работу',callback_data:`site_review_${event.id}`},{text:'Ответить',callback_data:`site_reply_${event.id}`}],[{text:'Закрыть заявку',callback_data:`site_close_${event.id}`}]];
          const admins = this.adminIds();
          if (!admins.length) continue;
          for (const id of admins) await this.deliver(event, String(id), text, { reply_markup: { inline_keyboard } });
        } else if (event.kind === 'customer_update' && event.telegramUserId) {
          const text = `${event.reference}: ${labels[event.state] || 'Обновлена'}\n\n${event.reply?.text || 'Подробности доступны на сохранённой странице заявки.'}\n\nПоддержка: ${process.env.SUPPORT_CONTACT || '@l_dont_understand'}`;
          await this.deliver(event, String(event.telegramUserId), text);
        }
        this.acknowledged.push(event.eventId);
      }
      this.lastError = null;
    } catch (error) {
      const message = safeError(error);
      if (message !== this.lastError) this.logger.warn('[SITE]', message);
      this.lastError = message;
    } finally { this.busy = false; }
  }
  start() {
    if (!this.enabled || this.active) return;
    this.active = true;
    void this.sync();
    this.timer = setInterval(() => void this.sync(), this.intervalMs);
    this.timer.unref();
  }
  async stop() {
    this.active = false;
    clearInterval(this.timer);
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 50));
  }
  register(bot) {
    bot.start(async (ctx, next) => {
      if (!ctx.startPayload?.startsWith('site_')) return next();
      if (ctx.chat?.type !== 'private') return ctx.reply('Открой бота в личном чате.');
      const token = ctx.startPayload.slice(5);
      if (!/^[a-zA-Z0-9_-]{32}$/.test(token)) return ctx.reply('Некорректная ссылка на заявку.');
      try {
        const data = await this.call('/api/bridge/action', { action:'link', token, telegramUserId:String(ctx.from.id) });
        await ctx.reply(`Уведомления подключены: ${data.request.reference}.\n${labels[data.request.state] || 'Заявка получена'}\n\nОтвет продавца также появится на странице заявки.`, { reply_markup: { inline_keyboard: [[{text:'Открыть заявку',url:new URL(`/request/${data.request.id}#${token}`,this.url).href}]] } });
      } catch (error) { await ctx.reply(safeError(error)); }
    });
    bot.command('site', async ctx => {
      if (!this.enabled) return ctx.reply('Ссылка на магазин пока не настроена.');
      return ctx.reply('Каталог и заявки:', { reply_markup: { inline_keyboard: [[{text:'Открыть Ysobi Shop',url:this.url.href}]] } });
    });
    bot.action(/^site_(review|reply|close)_([a-f0-9-]{36})$/i, async ctx => {
      if (!this.isAdmin(ctx.from?.id) || ctx.chat?.type !== 'private') return ctx.answerCbQuery('Нет доступа');
      const [, action, id] = ctx.match;
      if (action === 'reply') {
        this.pendingReply.set(ctx.from.id, { id, expires: Date.now() + 900000 });
        return ctx.reply('Напиши одним сообщением ответ покупателю (до 1800 символов). Он появится на странице заявки. /cancel — отмена. Не отправляй пароли и платёжные данные.');
      }
      try {
        const result = await this.call('/api/bridge/action', { action, id });
        await ctx.reply(`Заявка: ${labels[result.state] || result.state}`);
      } catch (error) { await ctx.reply(safeError(error)); }
    });
    bot.use(async (ctx, next) => {
      const pending = this.pendingReply.get(ctx.from?.id);
      if (!pending) return next();
      if (Date.now() > pending.expires || ctx.message?.text === '/cancel') {
        this.pendingReply.delete(ctx.from.id);
        if (ctx.message?.text === '/cancel') return ctx.reply('Ответ отменён.');
        return next();
      }
      if (!ctx.message?.text || ctx.message.text.startsWith('/')) return next();
      if (!this.isAdmin(ctx.from.id) || ctx.chat?.type !== 'private') return next();
      const reply = ctx.message.text.trim();
      if (reply.length > 1800) return ctx.reply('Сократи ответ до 1800 символов.');
      try {
        await this.call('/api/bridge/action', { action:'reply', id:pending.id, reply });
        this.pendingReply.delete(ctx.from.id);
        await ctx.reply('Ответ сохранён на сайте. Если покупатель подключил уведомления, он получит его и здесь.');
      } catch (error) { await ctx.reply(safeError(error)); }
    });
  }
}
