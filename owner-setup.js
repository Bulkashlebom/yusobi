import { timingSafeEqual } from 'node:crypto';
import { readEnv, saveEnv } from './env-file.js';

export function registerOwnerSetup(bot, { getAdminIds, now = Date.now, onConnected = () => {} }) {
  const attempts = new Map();
  bot.command('connect', async ctx => {
    if (ctx.chat?.type !== 'private' || ctx.chat.id !== ctx.from?.id) return;
    if (getAdminIds().length) return ctx.reply('Владелец магазина уже подключён.');
    const secret = process.env.OWNER_SETUP_SECRET;
    if (!secret || now() > Number(process.env.OWNER_SETUP_EXPIRES || 0)) {
      return ctx.reply('Открой программу Ysobi Shop на своём ПК и получи новую команду подключения.');
    }
    const id = ctx.from.id;
    const previous = attempts.get(id) || 0;
    if (previous > now()) return;
    if (attempts.size > 1000) attempts.clear();
    attempts.set(id, now() + 5000);
    const received = Buffer.from(ctx.message.text.trim().split(/\s+/)[1] || '');
    const expected = Buffer.from(secret);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return ctx.reply('Команда подключения неверна. Скопируй её из программы на своём ПК.');
    }
    // Recheck disk state immediately before claiming; there is no await between
    // the check and the atomic write, so a second update cannot claim ownership.
    const env = readEnv();
    if (env.ADMIN_ID || env.ADMIN_IDS || env.OWNER_SETUP_SECRET !== secret) return;
    const support = env.SUPPORT_CONTACT || (ctx.from.username ? '@' + ctx.from.username : '');
    saveEnv({ ...env, ADMIN_ID: String(id), SUPPORT_CONTACT: support,
      OWNER_SETUP_SECRET: '', OWNER_SETUP_EXPIRES: '' });
    process.env.ADMIN_ID = String(id);
    process.env.SUPPORT_CONTACT = support;
    process.env.OWNER_SETUP_SECRET = '';
    onConnected();
    await ctx.reply('Ты подключён как владелец магазина. Отправь /start — появится меню администратора.');
  });
}
