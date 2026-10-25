import { AviedoClient } from './supplier.js';

let client;
function supplier() { return client ??= new AviedoClient(); }

export function registerSupplierCommands(bot, { isAdmin, escapeHtml }) {
  bot.command('supplier', async ctx => {
    if (!isAdmin(ctx.from?.id) || ctx.chat?.type !== 'private') return;
    try {
      const result = await supplier().balance();
      await ctx.reply(`Aviedo подключён.\nДоступно: ${result.data.available} ${result.data.currency}.\n` +
        'Баланс общий с FunPay. Закупки через Telegram пока выключены.\n' +
        '/supplier_product ID — проверить товар без покупки.');
    } catch (error) {
      await ctx.reply(`Не удалось проверить Aviedo: ${error.code || 'temporary_error'}. Проверь настройки сервера.`);
    }
  });
  bot.command('supplier_product', async ctx => {
    if (!isAdmin(ctx.from?.id) || ctx.chat?.type !== 'private') return;
    const id = ctx.message.text.trim().split(/\s+/)[1];
    if (!/^[1-9]\d*$/.test(id || '')) return ctx.reply('Пример: /supplier_product 482');
    try {
      const result = await supplier().product(id);
      const product = result.data;
      const name = product.name || product.title || `Товар ${id}`;
      const details = product.description || '';
      await ctx.reply(`<b>${escapeHtml(name)}</b>\nID Aviedo: ${id}\n` +
        `Доступен: ${product.available === true ? 'да' : 'нет'}\n\n` +
        escapeHtml(details).slice(0, 2500), { parse_mode: 'HTML' });
    } catch (error) { await ctx.reply(`Aviedo: ${error.code || 'temporary_error'}`); }
  });
}
