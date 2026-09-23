process.on('uncaughtException', (err) => {
  console.error('[CRITICAL CRASH PREVENTED] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL CRASH PREVENTED] Unhandled Rejection:', reason);
});

/**
 * bot.js - Основной файл Telegram-бота магазина цифровых товаров на Telegraf
 * Работает ИСКЛЮЧИТЕЛЬНО на собственных товарах администратора из локальной БД SQLite.
 *
 * ФУНКЦИОНАЛ:
 * 1. Типы товаров:
 *    - FIXED: Штучный товар (фикс. цена, авто-выдача или ручная выдача, покупка QTY шт.).
 *    - FLEXIBLE: Услуга пополнения баланса (клиент указывает сумму в диапазоне min..max + наценка/комиссия).
 * 2. Дробные числа:
 *    - Поддержка точек и запятых ("1,02" -> 1.02, 499.99).
 *    - Форматирование всех цен до сотых (102.50 ₽).
 * 3. Пошаговый мастер добавления товаров (FSM BACK / CANCEL):
 *    - Кнопки [ ◀️ Шаг назад ] и [ ❌ Отменить всё ] на каждом шаге.
 *    - Возможность вернуться и переписать любое поле.
 * 4. Управление и редактирование товаров в /admin:
 *    - Редактирование названий, описаний, цен, лимитов min/max и комиссии %.
 *    - Переключение типа доставки в 1 клик.
 *    - Скрытие/публикация на витрине.
 *    - Пополнение остатков и ключей.
 * 5. Проверка чеков администратором:
 *    - Подробный расчет комиссии и базовой суммы в чеке.
 *    - Выдача ровно qty ключей.
 *    - Защита от дублей.
 * 6. Возвраты (REFUND) и вечное сохранение выданных ключей в "🛍 Мои покупки".
 */

import http from 'http';

// 1. В САМОМ ВЕРХУ bot.js:
// Если bot.js запускается НАПРЯМУЮ как отдельный процесс (например, standalone на Railway или отдельном инстансе),
// поднимаем HTTP-сервер для прохождения Health Check.
// Если же bot.js импортируется в server.ts (Express), порт 3000 занимает основной Express веб-сервер.
const isDirectRun = Boolean(
  process.argv[1] && (process.argv[1].endsWith('bot.js') || process.argv[1].endsWith('bot.ts'))
);

const PORT = process.env.PORT || 3000;
let healthServer = null;

if (isDirectRun) {
  try {
    healthServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() }));
    });

    healthServer.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.log(`[HTTP NOTE] Порт ${PORT} уже слушается другим процессом.`);
      } else {
        console.error('[HTTP ERROR]:', err?.message || err);
      }
    });

    healthServer.listen(PORT, '0.0.0.0', () => {
      console.log(`[Standalone Bot] Health server listening on 0.0.0.0:${PORT}`);
    });
  } catch (httpErr) {
    console.error('[HTTP INIT ERROR]:', httpErr.message);
  }
}

import { Telegraf, Markup, session } from 'telegraf';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import db, {
  parseMoney,
  formatMoney,
  formatFeeLabel,
  calculateOrderFee,
  validateFlexibleAmount,
  getPopularQuickAmounts,
} from './db.js';
import wizard, {
  startWizard,
  renderWizardStep,
  pushWizardStep,
  popWizardStep,
  saveCreatedProduct,
} from './wizard.js';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const PAYMENT_DETAILS = process.env.PAYMENT_DETAILS || '▫️ Ozon Bank: 2204 2402 6074 8860\n▫️ Альфа-Банк / СБП: +7 (900) 123-45-67';
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || '@l_dont_understand';

if (!BOT_TOKEN) {
  console.warn('[BOT WARNING] Переменная BOT_TOKEN не указана в .env файле.');
}

export const bot = new Telegraf(BOT_TOKEN || 'DUMMY_TOKEN_NOT_CONFIGURED', {
  handlerTimeout: 9000000, // 9000 секунд вместо стандартных 90с во избежание TimeoutError
});

// Сессия Telegraf для хранения временных черновиков заказов
bot.use(session());

// Безопасный глобальный перехват и моментальный ответ на callback_query
// Telegram сразу снимает статус ожидания с кнопки, предотвращая зависание и таймауты
bot.use(async (ctx, next) => {
  if (ctx.callbackQuery) {
    // Немедленно подтверждаем callback query во избежание зависания "часиков" у пользователя
    ctx.answerCbQuery().catch(() => {});

    // Защищаем последующие повторные вызовы answerCbQuery от ошибок "query is too old / invalid"
    const origAnswer = ctx.answerCbQuery.bind(ctx);
    ctx.answerCbQuery = async (...args) => {
      try {
        return await origAnswer(...args);
      } catch (err) {
        return false;
      }
    };
  }
  return next();
});

// FSM-состояния пользователей
export const userStates = new Map();

/**
 * Получение списка разрешенных ID администраторов из ADMIN_IDS и ADMIN_ID
 */
export function getAdminIds() {
  const raw = `${process.env.ADMIN_IDS || ''},${process.env.ADMIN_ID || ''}`;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Экранирование HTML для безопасной отправки в Telegram
 */
export function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Проверка, является ли пользователь администратором (сверяется со списком ADMIN_IDS)
 */
export function isAdmin(userId) {
  if (!userId) return false;
  const adminIds = getAdminIds();
  return adminIds.includes(String(userId));
}

/**
 * Безопасная отправка сообщения
 */
export async function safeSendMessage(telegram, chatId, htmlText, extra = {}) {
  try {
    return await telegram.sendMessage(chatId, htmlText, { parse_mode: 'HTML', ...extra });
  } catch (err) {
    if (err.message?.includes("can't parse entities") || err.message?.includes('entity')) {
      const plain = htmlText.replace(/<[^>]*>/g, '');
      const plainOpts = { ...extra };
      delete plainOpts.parse_mode;
      try {
        return await telegram.sendMessage(chatId, plain, plainOpts);
      } catch (e) {
        console.error(`Ошибка отправки сообщения пользователю ${chatId}:`, e.message);
      }
    } else {
      console.error(`Ошибка sendMessage (${chatId}):`, err.message);
    }
  }
}

/**
 * Безопасное редактирование сообщения
 */
export async function safeEditMessage(ctx, htmlText, extra = {}) {
  try {
    return await ctx.editMessageText(htmlText, { parse_mode: 'HTML', ...extra });
  } catch (err) {
    if (err.message?.includes('message is not modified')) return;
    const chatId = ctx.chat?.id || ctx.from?.id;
    if (chatId) {
      return await safeSendMessage(ctx.telegram, chatId, htmlText, extra);
    }
  }
}

/**
 * Главная клавиатура для пользователя
 */
export function getMainMenuKeyboard(userId) {
  const buttons = [
    [Markup.button.callback('📦 Каталог товаров', 'menu_catalog')],
    [
      Markup.button.callback('🛍 Мои покупки', 'menu_my_orders'),
      Markup.button.callback('💬 Поддержка', 'menu_support'),
    ],
    [
      Markup.button.callback('ℹ️ О магазине / Гарантии', 'menu_about'),
    ],
  ];

  if (isAdmin(userId)) {
    buttons.push([Markup.button.callback('⚙️ Панель администратора', 'admin_panel')]);
  }

  return Markup.inlineKeyboard(buttons);
}

// ==========================================
// 1. БЕЗОПАСНОСТЬ: ГЛОБАЛЬНЫЕ MIDDLEWARES
// ==========================================

// Проверка на черный список (Blacklist Middleware) - блокирует все действия
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId) {
    const banned = db.isBlacklisted(userId);
    if (banned) {
      const banText =
        `⛔ <b>Доступ к магазину заблокирован!</b>\n\n` +
        `Вы внесены в черный список администрацией.\n` +
        `Причина: <i>${escapeHtml(banned.reason || 'Нарушение правил магазина')}</i>\n\n` +
        `Связь с поддержкой: ${escapeHtml(SUPPORT_CONTACT)}`;

      if (ctx.callbackQuery) {
        try {
          await ctx.answerCbQuery('⛔ Вы заблокированы в этом магазине.', { show_alert: true });
        } catch (e) {}
        return safeEditMessage(ctx, banText, Markup.inlineKeyboard([]));
      }
      return safeSendMessage(ctx.telegram, userId, banText);
    }
  }
  return next();
});

// Глобальный middleware isAdmin: жесткий контроль доступа ко всем админ-действиям
bot.use(async (ctx, next) => {
  if (ctx.callbackQuery && ctx.callbackQuery.data) {
    const data = ctx.callbackQuery.data;
    const adminPrefixes = [
      'admin_',
      'approve_',
      'reject_',
      'refund_',
      'ban_user_',
      'toggle_hidden_',
      'toggle_deliv_',
      'edit_prod_',
      'del_prod_',
      'repl_prod_',
      'wiz_',
    ];

    const isAdminAction = adminPrefixes.some((prefix) => data.startsWith(prefix));
    if (isAdminAction) {
      const userId = ctx.from?.id;
      if (!isAdmin(userId)) {
        try {
          await ctx.answerCbQuery('⛔ Доступ запрещен! Действие доступно только администраторам.', { show_alert: true });
        } catch (e) {}
        return;
      }
    }
  }

  return next();
});

// ==========================================
// ФОНОВЫЙ ТАЙМЕР: АВТО-ОТМЕНА ЗАКАЗОВ ПО ТАЙМАУТУ 20 МИН
// ==========================================
setInterval(async () => {
  try {
    const expired = db.cancelExpiredOrders(20);
    if (expired && expired.length > 0) {
      for (const ord of expired) {
        const uState = userStates.get(ord.user_id);
        if (uState?.orderId === ord.id) {
          userStates.delete(ord.user_id);
        }
        try {
          await safeSendMessage(
            bot.telegram,
            ord.user_id,
            `⏳ <b>Заказ #${ord.id} автоматически отменен.</b>\n\n` +
            `Истекло время ожидания оплаты (20 минут), чек не был загружен.\n` +
            `Зарезервированный товар возвращен на склад.`
          );
        } catch (e) {}
      }
    }
  } catch (err) {
    console.error('[CRON ERROR] Ошибка при авто-отмене заказов:', err);
  }
}, 60 * 1000);

// ==========================================
// КОМАНДЫ БОТА
// ==========================================

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : null;
  const firstName = ctx.from.first_name || '';

  // Регистрация пользователя в БД для рассылок и статистики
  try {
    db.registerUser(userId, username, firstName);
  } catch (err) {
    console.error('[DB REGISTER ERROR]:', err);
  }

  // Всегда сбрасываем текущий пошаговый визард и черновики при /start
  if (ctx.session) {
    ctx.session.draftOrder = null;
    ctx.session.step = null;
    ctx.session.newProduct = null;
  }
  userStates.delete(userId);

  const welcomeText =
    `👋 <b>Добро пожаловать в наш магазин цифровых товаров!</b>\n\n` +
    `Здесь вы можете приобрести проверенные цифровые товары, ключи, подписки и готовые аккаунты с гарантией.\n\n` +
    `⚡ <b>Автовыдача</b> — моментальная выдача данных сразу после подтверждения чека\n` +
    `✍️ <b>Ручная выдача</b> — индивидуальное оформление администратором\n` +
    `💳 <b>Пополнение баланса</b> — гибкое зачисление средств на ваш аккаунт по логину\n\n` +
    `Выберите раздел в меню ниже 👇`;

  await safeSendMessage(ctx.telegram, userId, welcomeText, getMainMenuKeyboard(userId));
});

// Команда аварийного сброса /cancel и обнуление FSM/сессий
bot.command('cancel', async (ctx) => {
  const userId = ctx.from.id;
  if (ctx.session) {
    ctx.session = {};
  }
  userStates.delete(userId);
  await ctx.reply('Действие отменено. Главное меню:', getMainMenuKeyboard(userId));
});

// Команда /help — прямая поддержка и ответы на частые вопросы
bot.command('help', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : null;
  const firstName = ctx.from.first_name || '';
  try {
    db.registerUser(userId, username, firstName);
  } catch (e) {}

  const rawContact = SUPPORT_CONTACT.trim();
  const contactLink = rawContact.startsWith('@')
    ? `https://t.me/${rawContact.slice(1)}`
    : rawContact.startsWith('http')
    ? rawContact
    : `https://t.me/${rawContact}`;

  const text =
    `💬 <b>Служба поддержки и помощь:</b>\n\n` +
    `Если у вас возник вопрос по заказу, оплате, выдаче товара или пополнению баланса — напишите напрямую продавцу.\n\n` +
    `👤 <b>Продавец / Поддержка:</b> <a href="${contactLink}">${escapeHtml(rawContact)}</a>\n` +
    `🕒 <b>Время ответа:</b> обычно от 5 до 15 минут в рабочее время.\n\n` +
    `Нажмите кнопку ниже, чтобы открыть диалог с поддержкой:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('💬 Написать продавцу', contactLink)],
    [Markup.button.callback('◀️ Главное меню', 'main_menu')],
  ]);

  await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard });
});

bot.command('admin', async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) {
    return ctx.reply('⛔ У вас нет доступа к панели администратора.');
  }
  await showAdminPanel(ctx);
});

// Команда создания бэкапа базы данных SQLite для администратора
bot.command('backup', async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) {
    return ctx.reply('⛔ Доступ запрещен. Команда /backup доступна только администраторам.');
  }

  const dbPath = path.join(process.cwd(), 'shop.db');
  if (!fs.existsSync(dbPath)) {
    return ctx.reply('❌ Файл базы данных shop.db не найден на сервере.');
  }

  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    await ctx.replyWithDocument(
      { source: dbPath, filename: `shop_backup_${dateStr}.db` },
      {
        caption:
          `💾 <b>Резервная копия базы данных SQLite (shop.db)</b>\n\n` +
          `📅 <b>Дата:</b> ${new Date().toLocaleString('ru-RU')}\n` +
          `🔒 Файл содержит все актуальные товары, остатки, заказы и черный список.`,
        parse_mode: 'HTML',
      }
    );
  } catch (err) {
    console.error('Ошибка при отправке бэкапа:', err);
    await ctx.reply(`❌ Ошибка отправки файла базы: ${err.message}`);
  }
});

// ==========================================
// НАВИГАЦИЯ И ПОЛЬЗОВАТЕЛЬСКИЕ РАЗДЕЛЫ
// ==========================================

// Главное меню
bot.action('main_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (ctx.session) {
    ctx.session.draftOrder = null;
    ctx.session.step = null;
  }
  userStates.delete(ctx.from.id);
  await safeEditMessage(
    ctx,
    `🏠 <b>Главное меню магазина:</b>\nВыберите интересующий вас раздел:`,
    getMainMenuKeyboard(ctx.from.id)
  );
});

// Раздел: Поддержка
bot.action('menu_support', async (ctx) => {
  await ctx.answerCbQuery();
  const rawContact = SUPPORT_CONTACT.trim();
  const contactLink = rawContact.startsWith('@')
    ? `https://t.me/${rawContact.slice(1)}`
    : rawContact.startsWith('http')
    ? rawContact
    : `https://t.me/${rawContact}`;

  const text =
    `💬 <b>Служба поддержки и связи с администратором:</b>\n\n` +
    `По всем вопросам покупок, пополнений, активаций и возвратов обращайтесь напрямую:\n\n` +
    `👤 <b>Контакты продавца:</b> <a href="${contactLink}">${escapeHtml(rawContact)}</a>\n` +
    `🕒 <b>Время ответа:</b> обычно от 5 до 15 минут в рабочее время.\n\n` +
    `Нажмите кнопку ниже, чтобы перейти в диалог с поддержкой:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('💬 Написать продавцу в Telegram', contactLink)],
    [Markup.button.callback('◀️ Назад в меню', 'main_menu')],
  ]);

  await safeEditMessage(ctx, text, keyboard);
});

// Раздел: О магазине / Гарантии
bot.action('menu_about', async (ctx) => {
  await ctx.answerCbQuery();
  const rawContact = SUPPORT_CONTACT.trim();
  const contactLink = rawContact.startsWith('@')
    ? `https://t.me/${rawContact.slice(1)}`
    : rawContact.startsWith('http')
    ? rawContact
    : `https://t.me/${rawContact}`;

  const text =
    `ℹ️ <b>О нашем магазине и гарантиях:</b>\n\n` +
    `Мы предоставляем качественные цифровые товары, ключи активации, подписки и услуги прямого пополнения баланса.\n\n` +
    `🛡️ <b>НАШИ ГАРАНТИИ:</b>\n` +
    `• <b>100% работоспособность:</b> все ключи и аккаунты проверяются перед добавлением на витрину.\n` +
    `• <b>Гарантия на весь срок:</b> при любых проблемах производится быстрая замена товара или полный возврат средств.\n` +
    `• <b>Безопасность платежей:</b> оплата через СБП/Банки с проверкой чека реальным администратором.\n\n` +
    `🔄 <b>КАК ПРОИСХОДИТ ПОКУПКА:</b>\n` +
    `1. Вы выбираете товар или услугу в каталоге и указываете количество.\n` +
    `2. Переводите оплату по указанным реквизитам и отправляете фото/файл чека в чат.\n` +
    `3. Администратор сверяет поступление и бот мгновенно выдает цифровой ключ/доступ.\n\n` +
    `🕒 <b>Время ответа поддержки:</b> 5–15 минут (с 09:00 до 23:00 по МСК).\n` +
    `👤 <b>Прямой контакт:</b> <a href="${contactLink}">${escapeHtml(rawContact)}</a>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('💬 Написать продавцу', contactLink)],
    [Markup.button.callback('📦 Перейти в каталог', 'menu_catalog')],
    [Markup.button.callback('◀️ Назад в меню', 'main_menu')],
  ]);

  await safeEditMessage(ctx, text, keyboard);
});

// Раздел: Мои покупки
bot.action('menu_my_orders', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const orders = db.getOrdersByUser(userId);

  if (!orders || orders.length === 0) {
    return safeEditMessage(
      ctx,
      `🛍 <b>История ваших покупок:</b>\n\nУ вас пока нет оформленных заказов. Выберите товар в каталоге!`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📦 Перейти в каталог', 'menu_catalog')],
        [Markup.button.callback('◀️ Назад в меню', 'main_menu')],
      ])
    );
  }

  let text = `🛍 <b>История ваших покупок (всего: ${orders.length}):</b>\n`;
  text += `<i>Все ранее выданные ключи и данные сохранены ниже:</i>\n\n`;

  orders.slice(0, 8).forEach((ord) => {
    let statusBadge = '⏳ На проверке чека';
    if (ord.status === 'APPROVED') statusBadge = '✅ Выполнен';
    if (ord.status === 'REJECTED') statusBadge = '❌ Отклонен';
    if (ord.status === 'REFUNDED') statusBadge = '🔄 Возврат средств';

    const isFlex = ord.product_type === 'FLEXIBLE';
    const deliveryIcon = isFlex ? '💳' : (ord.product_delivery_type === 'MANUAL' ? '✍️' : '⚡');
    const qty = ord.quantity || 1;

    text += `<b>Заказ #${ord.id}</b> — ${escapeHtml(ord.product_name || 'Товар')}\n`;
    text += `💰 <b>${formatMoney(ord.amount)}</b> ${isFlex ? '(Пополнение)' : `(${qty} шт.)`} | ${deliveryIcon} ${statusBadge}\n`;

    if (ord.status === 'APPROVED') {
      const keysText = ord.delivered_keys || ord.seller_comment || ord.product_secret_data;
      if (keysText) {
        text += `🔑 <b>Выданные данные:</b>\n<pre>${escapeHtml(keysText)}</pre>\n`;
      } else {
        text += `🔑 <i>Услуга оказана администратором.</i>\n`;
      }
    } else if (ord.status === 'REFUNDED') {
      text += `ℹ️ <i>По заказу оформлен возврат средств.</i>\n`;
    } else if (ord.status === 'REJECTED' && ord.seller_comment) {
      text += `⚠️ Причина: <i>${escapeHtml(ord.seller_comment)}</i>\n`;
    }

    text += `━━━━━━━━━━━━━━━━━━━━\n`;
  });

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📦 В каталог', 'menu_catalog')],
    [Markup.button.callback('◀️ Назад в главное меню', 'main_menu')],
  ]);

  await safeEditMessage(ctx, text, keyboard);
});

// ==========================================
// КАТАЛОГ ТОВАРОВ И КАРТОЧКА
// ==========================================

/**
 * Отрисовка каталога товаров с категориями, поиском и постраничной навигацией
 */
export async function renderCatalogView(ctx, categoryTarget = 'root', page = 1, searchQuery = null) {
  if (ctx.session) {
    ctx.session.draftOrder = null;
    ctx.session.step = null;
  }

  // 1. Режим поисковой выдачи
  if (searchQuery !== null) {
    const result = db.searchAvailableProducts(searchQuery, { page, limit: 6 });
    if (!result.items || result.items.length === 0) {
      return safeEditMessage(
        ctx,
        `😔 <b>По вашему запросу ничего не найдено 😔</b>\n\nПопробуйте изменить поисковый запрос или вернитесь к категориям:`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🔍 Поиск по названию', 'catalog_search')],
          [Markup.button.callback('↩️ К категориям', 'menu_catalog')],
          [Markup.button.callback('◀️ Назад в меню', 'main_menu')],
        ])
      );
    }

    const buttons = result.items.map((prod) => {
      let icon = prod.emoji || (prod.delivery_type === 'MANUAL' ? '✍️' : '⚡');
      let priceLabel = formatMoney(prod.price);
      if (prod.product_type === 'FLEXIBLE') {
        const curSym = (prod.currency_symbol && String(prod.currency_symbol).trim()) || '₽';
        icon = prod.emoji || '💳';
        priceLabel = `от ${formatMoney(prod.min_amount, curSym)}`;
      }
      const nameShort = prod.name.length > 22 ? prod.name.slice(0, 20) + '..' : prod.name;
      return [Markup.button.callback(`${icon} ${nameShort} — ${priceLabel}`, `view_prod_${prod.id}_1`)];
    });

    if (result.totalPages > 1) {
      const pagRow = [];
      if (result.hasPrev) {
        pagRow.push(Markup.button.callback('⬅️', `search_page_${result.page - 1}`));
      }
      pagRow.push(Markup.button.callback(`Стр. ${result.page}/${result.totalPages}`, 'cat_page_noop'));
      if (result.hasNext) {
        pagRow.push(Markup.button.callback('➡️', `search_page_${result.page + 1}`));
      }
      buttons.push(pagRow);
    }

    buttons.push([
      Markup.button.callback('🔍 Поиск по названию', 'catalog_search'),
      Markup.button.callback('↩️ К категориям', 'menu_catalog'),
    ]);
    buttons.push([Markup.button.callback('◀️ В главное меню', 'main_menu')]);

    const text =
      `🔍 <b>Результаты поиска по «${escapeHtml(searchQuery)}» (найдено: ${result.total}):</b>\n\n` +
      `⚡ — Авто-выдача | ✍️ — Ручная | 💳 — Пополнение\n\n` +
      `Выберите лот для покупки:`;

    return safeEditMessage(ctx, text, Markup.inlineKeyboard(buttons));
  }

  // 2. Корневой каталог (выбор категорий или все товары)
  if (categoryTarget === 'root') {
    const categories = db.getAllCategories ? db.getAllCategories() : [];
    if (!categories || categories.length === 0) {
      // Если категорий нет, сразу открываем общий список с пагинацией
      return renderCatalogView(ctx, 'all', 1);
    }

    const allProducts = db.getAvailableProducts();
    if (!allProducts || allProducts.length === 0) {
      return safeEditMessage(
        ctx,
        `📭 <b>В данный момент все товары распроданы или забронированы!</b>\n\nАдминистратор скоро пополнит ассортимент. Загляните позже!`,
        Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад в меню', 'main_menu')]])
      );
    }

    const buttons = [];
    for (const cat of categories) {
      const res = db.getAvailableProductsByCategory(cat.id, { page: 1, limit: 1 });
      const count = res.total !== undefined ? res.total : 0;
      buttons.push([Markup.button.callback(`📁 ${cat.name} (${count} шт.)`, `cat_view_${cat.id}_1`)]);
    }

    const uncategorized = db.getAvailableProductsByCategory('NONE', { page: 1, limit: 1 });
    const uncategorizedCount = uncategorized.total !== undefined ? uncategorized.total : 0;
    if (uncategorizedCount > 0) {
      buttons.push([Markup.button.callback(`📁 Другие товары (${uncategorizedCount} шт.)`, 'cat_view_none_1')]);
    }

    buttons.push([
      Markup.button.callback('🔍 Поиск по названию', 'catalog_search'),
      Markup.button.callback('🌐 Все товары', 'cat_view_all_1'),
    ]);
    buttons.push([Markup.button.callback('◀️ Назад в главное меню', 'main_menu')]);

    const text =
      `📦 <b>Каталог товаров</b>\n\n` +
      `⚡ — Авто-выдача (мгновенно после проверки чека)\n` +
      `✍️ — Ручная выдача (администратор передаст лично)\n` +
      `💳 — Пополнение баланса (ввод суммы клиентом)\n\n` +
      `Выберите категорию или воспользуйтесь поиском:`;

    return safeEditMessage(ctx, text, Markup.inlineKeyboard(buttons));
  }

  // 3. Просмотр конкретной категории или всех товаров (с постраничной пагинацией)
  let result;
  let categoryTitle = '';
  if (categoryTarget === 'all') {
    result = db.getAvailableProductsByCategory('ALL', { page, limit: 6 });
    categoryTitle = '🌐 Все товары';
  } else if (categoryTarget === 'none') {
    result = db.getAvailableProductsByCategory('NONE', { page, limit: 6 });
    categoryTitle = '📁 Другие товары';
  } else {
    const catId = Number(categoryTarget);
    const cat = db.getCategoryById(catId);
    result = db.getAvailableProductsByCategory(catId, { page, limit: 6 });
    categoryTitle = cat ? `📁 ${cat.name}` : '📁 Товары категории';
  }

  if (!result.items || result.items.length === 0) {
    const emptyButtons = [
      [Markup.button.callback('↩️ К категориям', 'menu_catalog')],
      [Markup.button.callback('◀️ В главное меню', 'main_menu')],
    ];

    return safeEditMessage(
      ctx,
      `📭 <b>В этой категории пока пусто.</b>`,
      Markup.inlineKeyboard(emptyButtons)
    );
  }

  const buttons = result.items.map((prod) => {
    let icon = prod.emoji || (prod.delivery_type === 'MANUAL' ? '✍️' : '⚡');
    let priceLabel = formatMoney(prod.price);
    if (prod.product_type === 'FLEXIBLE') {
      const curSym = (prod.currency_symbol && String(prod.currency_symbol).trim()) || '₽';
      icon = prod.emoji || '💳';
      priceLabel = `от ${formatMoney(prod.min_amount, curSym)}`;
    }
    const nameShort = prod.name.length > 22 ? prod.name.slice(0, 20) + '..' : prod.name;
    return [Markup.button.callback(`${icon} ${nameShort} — ${priceLabel}`, `view_prod_${prod.id}_1`)];
  });

  if (result.totalPages > 1) {
    const pagRow = [];
    if (result.hasPrev) {
      pagRow.push(Markup.button.callback('⬅️', `cat_view_${categoryTarget}_${result.page - 1}`));
    }
    pagRow.push(Markup.button.callback(`Стр. ${result.page}/${result.totalPages}`, 'cat_page_noop'));
    if (result.hasNext) {
      pagRow.push(Markup.button.callback('➡️', `cat_view_${categoryTarget}_${result.page + 1}`));
    }
    buttons.push(pagRow);
  }

  buttons.push([
    Markup.button.callback('↩️ К категориям', 'menu_catalog'),
    Markup.button.callback('🔍 Поиск по названию', 'catalog_search'),
  ]);
  buttons.push([Markup.button.callback('◀️ В главное меню', 'main_menu')]);

  const text =
    `<b>${categoryTitle} (всего: ${result.total}):</b>\n\n` +
    `⚡ — Авто-выдача | ✍️ — Ручная | 💳 — Пополнение\n\n` +
    `Выберите лот для покупки:`;

  return safeEditMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

// Каталог доступных товаров
bot.action(['menu_catalog', 'catalog'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userStates.delete(ctx.from.id);
  await renderCatalogView(ctx, 'root', 1);
});

bot.action(/^cat_view_(\w+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const target = ctx.match[1];
  const page = Number(ctx.match[2]) || 1;
  userStates.delete(ctx.from.id);
  await renderCatalogView(ctx, target, page);
});

bot.action('cat_page_noop', async (ctx) => {
  await ctx.answerCbQuery('Вы на этой странице');
});

bot.action('catalog_search', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userStates.set(ctx.from.id, { type: 'USER_SEARCH_PRODUCTS', page: 1 });

  await safeEditMessage(
    ctx,
    `🔍 <b>Поиск товаров по каталогу:</b>\n\nОтправьте в чат название товара, ключевое слово или фразу (например: <i>Steam</i>, <i>VPN</i> или <i>Telegram</i>):`,
    Markup.inlineKeyboard([
      [Markup.button.callback('◀️ Назад в каталог', 'menu_catalog')],
    ])
  );
});

bot.action(/^search_page_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const page = Number(ctx.match[1]) || 1;
  const state = userStates.get(ctx.from.id);
  const q = state?.query || '';
  await renderCatalogView(ctx, 'search', page, q);
});

/**
 * Отрисовка карточки товара
 */
async function renderProductCard(ctx, productId, rawQty = 1) {
  const product = db.getProductById(productId);

  if (!product || product.is_hidden) {
    return safeEditMessage(
      ctx,
      `❌ Товар не найден или снят с продажи.`,
      Markup.inlineKeyboard([[Markup.button.callback('◀️ Вернуться в каталог', 'menu_catalog')]])
    );
  }

  // Карточка услуги пополнения баланса (FLEXIBLE)
  if (product.product_type === 'FLEXIBLE') {
    const feeText = formatFeeLabel(product);
    const curSym = (product.currency_symbol && String(product.currency_symbol).trim()) || '₽';
    const rate = product.exchange_rate || 1.0;
    const decimalsText = product.allow_decimals
      ? `🪙 Разрешены копейки / дробные (100.50 ${curSym})`
      : `🔢 Только целые числа (100, 500 ${curSym})`;

    let rateInfo = '';
    if (curSym !== '₽' || rate !== 1.0) {
      rateInfo = `💱 <b>Курс:</b> <b>1 ${curSym} = ${rate} ₽</b>\n`;
    }

    const cardText =
      `💳 <b>${product.emoji || '💳'} ${escapeHtml(product.name)}</b>\n\n` +
      `📝 <b>Описание:</b>\n${escapeHtml(product.description || 'Услуга пополнения баланса.')}\n\n` +
      rateInfo +
      `📊 <b>Допустимый диапазон сумм:</b>\n` +
      `От <b>${formatMoney(product.min_amount, curSym)}</b> до <b>${formatMoney(product.max_amount, curSym)}</b>\n\n` +
      `📈 <b>Комиссия / наценка:</b> <b>${feeText}</b>\n` +
      `⚙️ <b>Формат ввода:</b> ${decimalsText}\n\n` +
      `⚡ <i>Выберите готовую сумму ниже или введите любую свою:</i>`;

    const quickAmounts = getPopularQuickAmounts(product.min_amount, product.max_amount, product.allow_decimals);
    const buttons = [];

    // Ряды быстрых кнопок сумм (по 2-3 в ряд)
    if (quickAmounts.length > 0) {
      const chunkSize = quickAmounts.length > 4 ? 3 : 2;
      for (let i = 0; i < quickAmounts.length; i += chunkSize) {
        const chunk = quickAmounts.slice(i, i + chunkSize);
        buttons.push(
          chunk.map((amt) =>
            Markup.button.callback(
              `${formatMoney(amt, curSym)}`,
              `buy_flex_preset_${product.id}_${amt}`
            )
          )
        );
      }
    }

    buttons.push([Markup.button.callback('✍️ Ввести свою сумму', `buy_flexible_${product.id}`)]);
    buttons.push([Markup.button.callback('◀️ Назад в каталог', 'menu_catalog')]);

    return safeEditMessage(ctx, cardText, Markup.inlineKeyboard(buttons));
  }

  // Карточка штучного товара (FIXED)
  const availableStock = db.getAvailableStock(product);
  const isOutOfStock = availableStock <= 0;

  let qty = Math.max(1, parseInt(rawQty, 10) || 1);
  if (!product.is_unlimited) {
    qty = isOutOfStock ? 1 : Math.min(qty, availableStock);
  }

  const totalAmount = Math.round(product.price * qty * 100) / 100;

  const isManual = product.delivery_type === 'MANUAL';
  const deliveryDesc = isManual
    ? '✍️ <b>Ручная выдача</b> (администратор свяжется с вами или передаст товар лично)'
    : '⚡ <b>Автовыдача</b> (ключи/данные будут выданы ботом сразу после подтверждения чека)';

  const stockDisplay = product.is_unlimited
    ? 'много'
    : isOutOfStock
    ? '0 шт. (Закончился / в брони)'
    : `${availableStock} шт.`;

  const cardText =
    `📦 <b>${escapeHtml(product.name)}</b>\n\n` +
    `📝 <b>Описание:</b>\n${escapeHtml(product.description || 'Описание не указано.')}\n\n` +
    `🚚 <b>Тип доставки:</b> ${deliveryDesc}\n` +
    `📊 <b>В наличии:</b> <b>${stockDisplay}</b>\n` +
    `💰 <b>Цена за 1 шт:</b> <b>${formatMoney(product.price)}</b>\n\n` +
    (!isOutOfStock
      ? `🔢 <b>Выбрано количество:</b> <b>${qty} шт.</b>\n` +
        `💳 <b>Итого к оплате:</b> <b>${formatMoney(totalAmount)}</b>\n\n` +
        `<i>Используйте кнопки [-] / [+] или укажите число вручную:</i>`
      : `⚠️ <i>Товар временно закончился на складе или забронирован на оплату.</i>`);

  const keyboardButtons = [];

  if (isOutOfStock) {
    keyboardButtons.push([Markup.button.callback('🚫 Нет в наличии', `prod_out_of_stock_${product.id}`)]);
  } else {
    keyboardButtons.push([
      Markup.button.callback('➖', `qty_minus_${product.id}_${qty}`),
      Markup.button.callback(`🔢 ${qty} шт.`, `qty_input_prompt_${product.id}`),
      Markup.button.callback('➕', `qty_plus_${product.id}_${qty}`),
    ]);

    if (product.requires_availability_check) {
      keyboardButtons.push([
        Markup.button.callback(
          '🔍 Запросить наличие у продавца',
          `request_stock_check_${product.id}_${qty}`
        ),
      ]);
    } else {
      keyboardButtons.push([
        Markup.button.callback(`💳 Купить ${qty} шт. за ${formatMoney(totalAmount)}`, `buy_prod_${product.id}_${qty}`),
      ]);
    }
  }

  keyboardButtons.push([Markup.button.callback('◀️ Назад в каталог', 'menu_catalog')]);

  await safeEditMessage(ctx, cardText, Markup.inlineKeyboard(keyboardButtons));
}

// Карточка товара
bot.action(/^view_prod_(\d+)(?:_(\d+))?$/, async (ctx) => {
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);
  const qty = Number(ctx.match[2] || 1);
  await renderProductCard(ctx, productId, qty);
});

// Клик по кнопке "Нет в наличии"
bot.action(/^prod_out_of_stock_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('⚠️ Товар закончился или ожидает оплаты другим покупателем!', { show_alert: true });
});

// Изменение QTY: кнопка Минус [-]
bot.action(/^qty_minus_(\d+)_(\d+)$/, async (ctx) => {
  const productId = Number(ctx.match[1]);
  const currentQty = Number(ctx.match[2]);

  if (currentQty <= 1) {
    return ctx.answerCbQuery('Минимум 1 штука');
  }

  await ctx.answerCbQuery();
  await renderProductCard(ctx, productId, currentQty - 1);
});

// Изменение QTY: кнопка Плюс [+]
bot.action(/^qty_plus_(\d+)_(\d+)$/, async (ctx) => {
  const productId = Number(ctx.match[1]);
  const currentQty = Number(ctx.match[2]);
  const product = db.getProductById(productId);

  if (!product) return ctx.answerCbQuery('Товар не найден');

  const maxStock = db.getAvailableStock(product);

  if (!product.is_unlimited && currentQty >= maxStock) {
    return ctx.answerCbQuery(`Доступно только ${maxStock} шт.!`, { show_alert: true });
  }

  await ctx.answerCbQuery();
  await renderProductCard(ctx, productId, currentQty + 1);
});

// Ручной ввод QTY кликом по центральной кнопке [ 🔢 X шт. ]
bot.action(/^qty_input_prompt_(\d+)$/, async (ctx) => {
  const productId = Number(ctx.match[1]);
  const product = db.getProductById(productId);
  if (!product) return ctx.answerCbQuery('Товар не найден');

  const maxStock = db.getAvailableStock(product);
  if (maxStock <= 0) return ctx.answerCbQuery('Товар закончился');

  await ctx.answerCbQuery();
  userStates.set(ctx.from.id, {
    type: 'AWAITING_QTY_INPUT',
    productId: productId,
  });

  const text =
    `🔢 <b>Ввод количества для «${escapeHtml(product.name)}»</b>\n\n` +
    `В наличии: <b>${product.is_unlimited ? 'много' : maxStock + ' шт.'}</b>\n` +
    `Стоимость: <b>${formatMoney(product.price)} / шт.</b>\n\n` +
    `Отправьте в чат желаемое количество (целое число от 1 до ${product.is_unlimited ? 999 : maxStock}):`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Отмена', `view_prod_${productId}_1`)],
  ]);

  await safeEditMessage(ctx, text, keyboard);
});

// ==========================================
// ПОКУПКА УСЛУГИ ПОПОЛНЕНИЯ (FLEXIBLE)
// ==========================================

// 1. Покупка по быстрой кнопке с фиксированной суммой (quick-amounts)
bot.action(/^buy_flex_preset_(\d+)_([\d.]+)$/, async (ctx) => {
  const userId = ctx.from.id;
  db.cancelExpiredOrders(20);

  // ПРОВЕРКА: активный заказ возвращается ТОЛЬКО если статус PENDING и чек отправлен на проверку
  const activeOrder = db.getActiveOrder(userId);
  if (activeOrder) {
    return ctx.answerCbQuery('⚠️ У вас уже есть активный заказ #' + activeOrder.id + ' на проверке', { show_alert: true });
  }

  await ctx.answerCbQuery().catch(() => {});
  const productId = Number(ctx.match[1]);
  const rawAmount = ctx.match[2];
  const product = db.getProductById(productId);

  if (!product || product.is_hidden || product.product_type !== 'FLEXIBLE') {
    return safeEditMessage(ctx, '❌ Услуга пополнения недоступна.', Markup.inlineKeyboard([[Markup.button.callback('В каталог', 'menu_catalog')]]));
  }

  const validation = validateFlexibleAmount(product, rawAmount);
  if (!validation.valid) {
    return safeEditMessage(ctx, `⚠️ ${validation.error}`, Markup.inlineKeyboard([[Markup.button.callback('◀️ К товару', `view_prod_${product.id}_1`)]]));
  }

  const calc = calculateOrderFee(product, validation.amount);
  const curSym = (product.currency_symbol && String(product.currency_symbol).trim()) || '₽';

  // НЕ СОЗДАВАТЬ ЗАКАЗ В БД ДО ОТПРАВКИ ЧЕКА! Сохраняем черновик исключительно в сессию:
  if (!ctx.session) ctx.session = {};
  ctx.session.draftOrder = {
    productId: product.id,
    productName: product.name,
    productType: product.product_type,
    amount: calc.baseAmount,
    totalPrice: calc.totalAmount,
    baseAmount: calc.baseAmount,
    baseRub: calc.baseRub,
    feeAmount: calc.feeAmount,
    feePercent: calc.feePercent,
    feeType: calc.feeType,
    feeValue: calc.feeValue,
    feeBreakdownText: calc.feeBreakdownText,
    currencySymbol: curSym,
    exchangeRate: calc.exchangeRate,
    quantity: 1,
    buyerComment: null,
    step: 'AWAIT_LOGIN',
  };
  ctx.session.step = 'AWAIT_LOGIN';

  userStates.set(userId, {
    type: 'AWAITING_ORDER_COMMENT',
    draftOrder: ctx.session.draftOrder,
  });

  const promptText =
    `💬 <b>Оформление заявки на пополнение:</b>\n\n` +
    `💳 <b>Услуга:</b> ${product.emoji || '💳'} ${escapeHtml(product.name)}\n` +
    `┌ 📥 <b>К зачислению на баланс:</b> <b>${formatMoney(calc.baseAmount, curSym)}</b>` +
    (calc.exchangeRate !== 1 || curSym !== '₽' ? ` (~${formatMoney(calc.baseRub, '₽')})\n` : '\n') +
    `├ 📊 <b>Комиссия сервиса:</b> <b>${calc.feeBreakdownText}</b>\n` +
    `└ 💰 <b>Итого к оплате:</b> <b>${formatMoney(calc.totalAmount, '₽')}</b>\n\n` +
    `Укажите логин или реквизиты вашего аккаунта (например: логин Steam или ID аккаунта):`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🛑 Отменить заказ', 'cancel_order_')],
  ]);

  await safeEditMessage(ctx, promptText, keyboard);
});

// 2. Ввод произвольной суммы клиентом
bot.action(/^buy_flexible_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  db.cancelExpiredOrders(20);

  const activeOrder = db.getActiveOrder(userId);
  if (activeOrder) {
    return ctx.answerCbQuery('⚠️ У вас уже есть активный заказ #' + activeOrder.id + ' на проверке', { show_alert: true });
  }

  await ctx.answerCbQuery().catch(() => {});
  const productId = Number(ctx.match[1]);
  const product = db.getProductById(productId);

  if (!product || product.is_hidden) {
    return safeEditMessage(ctx, '❌ Товар недоступен.', Markup.inlineKeyboard([[Markup.button.callback('В каталог', 'menu_catalog')]]));
  }

  userStates.set(userId, {
    type: 'AWAITING_FLEXIBLE_AMOUNT',
    productId: product.id,
  });

  const curSym = (product.currency_symbol && String(product.currency_symbol).trim()) || '₽';
  const feeNote = formatFeeLabel(product);
  let rateNote = '';
  if (curSym !== '₽' || (product.exchange_rate && product.exchange_rate !== 1.0)) {
    rateNote = `💱 <b>Курс:</b> 1 ${curSym} = ${product.exchange_rate || 1.0} ₽\n`;
  }
  const decimalsNote = product.allow_decimals
    ? `<i>Поддерживаются как целые числа, так и дробные (например: 500 или 1500.50 ${curSym}).</i>`
    : `<i>Пожалуйста, вводите только целые суммы без копеек (например: 500 или 1000 ${curSym}).</i>`;

  const text =
    `💳 <b>Пополнение «${product.emoji || '💳'} ${escapeHtml(product.name)}»</b>\n\n` +
    rateNote +
    `📊 <b>Допустимый диапазон:</b> от <b>${formatMoney(product.min_amount, curSym)}</b> до <b>${formatMoney(product.max_amount, curSym)}</b>\n` +
    `📈 <b>Комиссия / наценка:</b> <b>${feeNote}</b>\n\n` +
    `Отправьте желаемую сумму зачисления в валюте <b>${curSym}</b> в чат:\n${decimalsNote}`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Отмена', `view_prod_${product.id}_1`)],
  ]);

  await safeEditMessage(ctx, text, keyboard);
});

// ==========================================
// ОФОРМЛЕНИЕ ШТУЧНОГО ЗАКАЗА
// ==========================================

bot.action(/^buy_prod_(\d+)_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  db.cancelExpiredOrders(20);

  const activeOrder = db.getActiveOrder(userId);
  if (activeOrder) {
    return ctx.answerCbQuery('⚠️ У вас уже есть активный заказ #' + activeOrder.id + ' на проверке', { show_alert: true });
  }

  const productId = Number(ctx.match[1]);
  const qty = Math.max(1, Number(ctx.match[2]) || 1);
  const product = db.getProductById(productId);

  if (!product || product.is_sold || product.is_hidden) {
    await ctx.answerCbQuery('❌ Товар недоступен!', { show_alert: true });
    return safeEditMessage(ctx, `❌ Товар недоступен для покупки.`, Markup.inlineKeyboard([[Markup.button.callback('В каталог', 'menu_catalog')]]));
  }

  const availableStock = db.getAvailableStock(product);
  if (!product.is_unlimited && qty > availableStock) {
    await ctx.answerCbQuery(`❌ Доступно только ${availableStock} шт.!`, { show_alert: true });
    return renderProductCard(ctx, productId, availableStock);
  }

  await ctx.answerCbQuery().catch(() => {});

  const totalAmount = Math.round(product.price * qty * 100) / 100;

  // Сохраняем параметры выбора исключительно в сессию (без создания заказа в БД до чека)
  if (!ctx.session) ctx.session = {};
  ctx.session.draftOrder = {
    productId: product.id,
    productName: product.name,
    productType: product.product_type,
    deliveryType: product.delivery_type,
    amount: totalAmount,
    totalPrice: totalAmount,
    baseAmount: totalAmount,
    feeAmount: 0,
    feePercent: 0,
    feeType: 'NONE',
    feeValue: 0,
    quantity: qty,
    buyerComment: null,
    step: 'AWAIT_LOGIN',
  };
  ctx.session.step = 'AWAIT_LOGIN';

  userStates.set(userId, {
    type: 'AWAITING_ORDER_COMMENT',
    draftOrder: ctx.session.draftOrder,
  });

  const promptText =
    `💬 <b>Оформление покупки:</b>\n\n` +
    `📦 <b>Товар:</b> ${escapeHtml(product.name)}\n` +
    `🔢 <b>Количество:</b> ${qty} шт.\n` +
    `💰 <b>Сумма к оплате:</b> <b>${formatMoney(totalAmount)}</b>\n\n` +
    `Напишите комментарий к заказу (пожелание, никнейм, ссылку на аккаунт) или нажмите <b>[Пропустить]</b>:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➡️ Пропустить комментарий', 'skip_comment_draft')],
    [Markup.button.callback('🛑 Отменить заказ', 'cancel_order_')],
  ]);

  await safeEditMessage(ctx, promptText, keyboard);
});

// Пропуск комментария к заказу
bot.action(/^skip_comment_?(.*)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const draft = ctx.session?.draftOrder || userStates.get(userId)?.draftOrder;
  if (draft) {
    draft.step = 'AWAITING_RECEIPT';
    if (ctx.session) {
      ctx.session.draftOrder = draft;
      ctx.session.step = 'AWAITING_RECEIPT';
    }
    userStates.set(userId, {
      type: 'AWAITING_RECEIPT',
      draftOrder: draft,
    });
    return sendDraftPaymentInstructions(ctx, draft);
  }

  const orderId = Number(ctx.match[1]);
  if (orderId) {
    const order = db.getOrderById(orderId);
    if (order) {
      userStates.set(userId, {
        type: 'AWAITING_RECEIPT',
        orderId: orderId,
      });
      return sendPaymentInstructions(ctx, order);
    }
  }

  return safeEditMessage(ctx, '❌ Оформление не найдено.', Markup.inlineKeyboard([[Markup.button.callback('В каталог', 'catalog')]]));
});

// ==========================================
// ПРЕДВАРИТЕЛЬНАЯ ПРОВЕРКА НАЛИЧИЯ (CHECK AVAILABILITY)
// ==========================================

bot.action(/^request_stock_check_(\d+)_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  db.cancelExpiredOrders(20);

  const activeOrder = db.getActiveOrder(userId);
  if (activeOrder) {
    return ctx.answerCbQuery('⚠️ У вас уже есть активный заказ #' + activeOrder.id + ' на проверке', { show_alert: true });
  }

  const productId = Number(ctx.match[1]);
  const qty = Math.max(1, Number(ctx.match[2]) || 1);
  const product = db.getProductById(productId);

  if (!product || product.is_sold || product.is_hidden) {
    await ctx.answerCbQuery('❌ Товар недоступен!', { show_alert: true });
    return safeEditMessage(ctx, `❌ Товар недоступен для покупки.`, Markup.inlineKeyboard([[Markup.button.callback('В каталог', 'menu_catalog')]]));
  }

  const totalAmount = Math.round(product.price * qty * 100) / 100;
  const buyerUsername = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'клиент');

  // Создаем заказ в статусе CHECKING_STOCK без бронирования до подтверждения
  const order = db.createOrder({
    user_id: userId,
    username: ctx.from.username || ctx.from.first_name || 'клиент',
    product_id: product.id,
    amount: totalAmount,
    base_amount: totalAmount,
    quantity: qty,
    reserve: false,
    status: 'CHECKING_STOCK',
  });

  await ctx.answerCbQuery('Запрос отправлен продавцу!');

  const buyerText =
    `⏳ <b>Запрос отправлен продавцу.</b>\n\n` +
    `Мы проверяем актуальность товара на складе / у поставщика.\n` +
    `📦 <b>Лот:</b> ${escapeHtml(product.name)} (${qty} шт.)\n` +
    `💰 <b>Сумма:</b> <b>${formatMoney(totalAmount)}</b>\n` +
    `🧾 <b>Заявка:</b> #${order.id}\n\n` +
    `Как только продавец подтвердит наличие, вам придет уведомление со ссылкой и реквизитами на оплату. Пожалуйста, ожидайте! 🚀`;

  const buyerKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📦 Каталог товаров', 'catalog')],
    [Markup.button.callback('🛑 Отозвать запрос', `cancel_order_${order.id}`)],
  ]);

  await safeEditMessage(ctx, buyerText, buyerKeyboard);

  // Уведомляем администратора(ов)
  const adminIds = getAdminIds();
  if (adminIds.length > 0) {
    const adminText =
      `🔍 <b>ЗАПРОС НАЛИЧИЯ ТОВАРА!</b>\n\n` +
      `🧾 <b>Заявка:</b> #${order.id}\n` +
      `👤 <b>Покупатель:</b> ${escapeHtml(buyerUsername)} (ID: <code>${userId}</code>)\n` +
      `📦 <b>Товар:</b> ${escapeHtml(product.name)}\n` +
      `🔢 <b>Количество:</b> ${qty} шт.\n` +
      `💰 <b>Сумма:</b> <b>${formatMoney(totalAmount)}</b>\n\n` +
      `Проверьте фактическое наличие и выберите действие:`;

    const adminKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(`🟢 В наличии (Выставить счет)`, `admin_stock_yes_${order.id}`),
        Markup.button.callback(`🔴 Нет в наличии`, `admin_stock_no_${order.id}`),
      ],
    ]);

    for (const adminId of adminIds) {
      try {
        await safeSendMessage(ctx.telegram, adminId, adminText, adminKeyboard);
      } catch (err) {
        console.error(`[ADMIN NOTIFY ERROR] Не удалось отправить уведомление о наличии админу ${adminId}:`, err.message);
      }
    }
  }
});

// ПОЛНЫЙ ФИКС КНОПКИ «ОТМЕНИТЬ ЗАКАЗ»
bot.action(/cancel_order_?(\d*)/, async (ctx) => {
  await ctx.answerCbQuery('Заказ отменен').catch(() => {});
  const orderId = ctx.match[1];

  // Если заказ уже был в базе:
  if (orderId) {
    db.cancelOrder(orderId, 'Отменен покупателем');
  }

  // Если это был черновик в сессии:
  if (ctx.session) {
    ctx.session.draftOrder = null;
    ctx.session.step = null;
  }
  userStates.delete(ctx.from.id);

  await ctx.deleteMessage().catch(() => {});
  await ctx.reply('❌ Оформление отменено. Вы можете выбрать другой товар в каталоге.', 
    Markup.inlineKeyboard([[Markup.button.callback('📦 Каталог товаров', 'catalog')]])
  );
});

/**
 * Отправка инструкций по оплате для черновика заказа (до создания в БД)
 */
async function sendDraftPaymentInstructions(ctx, draft) {
  const isFlex = draft.productType === 'FLEXIBLE';

  const commentLine = draft.buyerComment
    ? `\n💬 <b>Реквизиты/логин:</b> <code>${escapeHtml(draft.buyerComment)}</code>`
    : '';

  let breakdownText = '';
  const totalAmt = draft.totalPrice || draft.amount;
  if (isFlex && draft.baseAmount) {
    const curSym = draft.currencySymbol || '₽';
    let feeLine = '0% (без комиссии)';
    if (draft.feeAmount > 0) {
      if (draft.feeType === 'FIXED') {
        feeLine = `+${formatMoney(draft.feeValue || draft.feeAmount, '₽')} (фикс.)`;
      } else {
        feeLine = `+${draft.feePercent}% (+${formatMoney(draft.feeAmount, '₽')})`;
      }
    }

    breakdownText =
      `💳 <b>Услуга:</b> ${escapeHtml(draft.productName)}\n` +
      `┌ 📥 <b>К зачислению:</b> <b>${formatMoney(draft.baseAmount, curSym)}</b>` +
      (draft.exchangeRate && draft.exchangeRate !== 1 ? ` (~${formatMoney(draft.baseRub || (draft.baseAmount * draft.exchangeRate), '₽')})\n` : '\n') +
      `├ 📊 <b>Комиссия сервиса:</b> <b>${feeLine}</b>\n` +
      (draft.discountAmount > 0 ? `├ 🎟 <b>Скидка (${escapeHtml(draft.promoCode)}):</b> <b>-${formatMoney(draft.discountAmount, '₽')}</b>\n` : '') +
      `└ 💰 <b>Итого к переводу:</b> <b>${formatMoney(totalAmt, '₽')}</b>\n`;
  } else {
    breakdownText =
      `📦 <b>Товар:</b> ${escapeHtml(draft.productName)} (${draft.quantity || 1} шт.)\n` +
      (draft.discountAmount > 0
        ? `┌ 💵 <b>Стоимость:</b> ${formatMoney(draft.originalTotalPrice || (totalAmt + draft.discountAmount))}\n` +
          `├ 🎟 <b>Скидка (${escapeHtml(draft.promoCode)}):</b> <b>-${formatMoney(draft.discountAmount)}</b>\n` +
          `└ 💰 <b>Итого к оплате:</b> <b>${formatMoney(totalAmt)}</b>\n`
        : `💰 <b>Сумма к оплате:</b> <b>${formatMoney(totalAmt)}</b>\n`);
  }

  const text =
    `🧾 <b>Оформление заявки на оплату</b>\n\n` +
    breakdownText +
    commentLine + '\n\n' +
    `💳 <b>Реквизиты для перевода (нажмите для копирования):</b>\n` +
    `<code>${escapeHtml(PAYMENT_DETAILS)}</code>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📸 <b>ИНСТРУКЦИЯ ПО ОПЛАТЕ:</b>\n` +
    `1. Переведите точную сумму <b>${formatMoney(totalAmt)}</b> по указанным реквизитам.\n` +
    `2. Сохраните чек или квитанцию перевода.\n` +
    `3. <b>Отправьте фото или файл чека в этот чат!</b>\n\n` +
    `⏳ <i>Бот ожидает отправку чека... Заказ будет зарегистрирован сразу после загрузки чека.</i>`;

  const promoButtonText = draft.promoCode
    ? `🎟 Промокод: ${draft.promoCode} (-${formatMoney(draft.discountAmount)})`
    : '🎟 Ввести промокод';

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Скопировать реквизиты', 'copy_payment_details_draft')],
    [Markup.button.callback(promoButtonText, 'enter_promocode')],
    [Markup.button.callback('🛑 Отменить заказ', 'cancel_order_')],
  ]);

  if (ctx.callbackQuery) {
    await safeEditMessage(ctx, text, keyboard);
  } else {
    await safeSendMessage(ctx.telegram, ctx.from.id, text, keyboard);
  }
}

bot.action('enter_promocode', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const draft = ctx.session?.draftOrder || userStates.get(userId)?.draftOrder;
  if (!draft) {
    return ctx.reply('❌ Оформление заказа не найдено. Выберите товар в каталоге:', getMainMenuKeyboard(userId));
  }

  userStates.set(userId, {
    type: 'AWAITING_PROMOCODE',
    draftOrder: draft,
  });

  const orderSum = draft.originalTotalPrice || draft.totalPrice || draft.amount;

  const text =
    `🎟 <b>Применение скидочного промокода</b>\n\n` +
    `Товар: <b>${escapeHtml(draft.productName)}</b>\n` +
    `Сумма заказа: <b>${formatMoney(orderSum)}</b>\n\n` +
    `Отправьте промокод в этот чат (например: <code>SALE100</code>):\n` +
    `<i>Регистр букв значения не имеет.</i>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Отмена', 'cancel_promocode_input')],
  ]);

  if (ctx.callbackQuery) {
    await safeEditMessage(ctx, text, keyboard);
  } else {
    await safeSendMessage(ctx.telegram, userId, text, keyboard);
  }
});

bot.action('cancel_promocode_input', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const draft = ctx.session?.draftOrder || userStates.get(userId)?.draftOrder;
  if (!draft) {
    userStates.delete(userId);
    return showMainMenu(ctx);
  }

  userStates.set(userId, {
    type: 'AWAITING_RECEIPT',
    draftOrder: draft,
  });

  await sendDraftPaymentInstructions(ctx, draft);
});

bot.action('copy_payment_details_draft', async (ctx) => {
  await ctx.answerCbQuery('Реквизиты скопированы!', { show_alert: false }).catch(() => {});
  const draft = ctx.session?.draftOrder || userStates.get(ctx.from.id)?.draftOrder;
  const amt = draft ? formatMoney(draft.totalPrice || draft.amount) : '';

  await ctx.reply(
    `📋 <b>Реквизиты для оплаты:</b>\n\n` +
    `<code>${escapeHtml(PAYMENT_DETAILS)}</code>\n\n` +
    (amt ? `💰 Сумма к переводу: <b>${amt}</b>\n` : '') +
    `<i>Нажмите на текст реквизитов выше, чтобы скопировать. После оплаты пришлите фото или файл чека!</i>`,
    { parse_mode: 'HTML' }
  );
});

/**
 * Отправка инструкций по оплате и реквизитов
 */
async function sendPaymentInstructions(ctx, order) {
  const isFlex = order.product_type === 'FLEXIBLE';

  const commentLine = order.buyer_comment
    ? `\n💬 <b>Реквизиты/комментарий:</b> <code>${escapeHtml(order.buyer_comment)}</code>`
    : '';

  let breakdownText = '';
  if (isFlex && order.base_amount) {
    const prod = order.product_id ? db.getProductById(order.product_id) : null;
    const curSym = (prod?.currency_symbol && String(prod.currency_symbol).trim()) || '₽';
    let feeLine = '0% (без комиссии)';
    if (order.fee_amount > 0) {
      if (order.fee_type === 'FIXED') {
        feeLine = `+${formatMoney(order.fee_value || order.fee_amount, '₽')} (фикс.)`;
      } else {
        feeLine = `+${order.fee_percent}% (+${formatMoney(order.fee_amount, '₽')})`;
      }
    }

    breakdownText =
      `💳 <b>Услуга:</b> ${escapeHtml(order.product_name)}\n` +
      `┌ 📥 <b>К зачислению:</b> <b>${formatMoney(order.base_amount, curSym)}</b>\n` +
      `├ 📊 <b>Комиссия сервиса:</b> <b>${feeLine}</b>\n` +
      `└ 💰 <b>Итого к переводу:</b> <b>${formatMoney(order.amount, '₽')}</b>\n`;
  } else {
    breakdownText =
      `📦 <b>Товар:</b> ${escapeHtml(order.product_name)} (${order.quantity || 1} шт.)\n` +
      `💰 <b>Сумма к оплате:</b> <b>${formatMoney(order.amount)}</b>\n` +
      `🔒 <i>Товар зарезервирован на время оплаты</i>\n`;
  }

  const text =
    `🧾 <b>Заказ #${order.id} сформирован!</b>\n\n` +
    breakdownText +
    commentLine + '\n\n' +
    `💳 <b>Реквизиты для перевода (нажмите для копирования):</b>\n` +
    `<code>${escapeHtml(PAYMENT_DETAILS)}</code>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📸 <b>ИНСТРУКЦИЯ ПО ОПЛАТЕ:</b>\n` +
    `1. Переведите точную сумму <b>${formatMoney(order.amount)}</b> по указанным реквизитам.\n` +
    `2. Сохраните чек или квитанцию перевода.\n` +
    `3. <b>Отправьте фото или файл чека в этот чат!</b>\n\n` +
    `⏳ <i>Бот ожидает отправку чека...</i>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Скопировать реквизиты', `copy_payment_details_${order.id}`)],
    [Markup.button.callback('🛑 Отменить заказ', `cancel_order_${order.id}`)],
  ]);

  if (ctx.callbackQuery) {
    await safeEditMessage(ctx, text, keyboard);
  } else {
    await safeSendMessage(ctx.telegram, ctx.from.id, text, keyboard);
  }
}

// Быстрое копирование реквизитов оплаты
bot.action(/^copy_payment_details_(\d+)$/, async (ctx) => {
  const orderId = Number(ctx.match[1]);
  const order = db.getOrderById(orderId);

  // Выводим системный alert и отправляем реквизиты чистым блоком
  await ctx.answerCbQuery('Реквизиты скопированы!', { show_alert: false });

  await ctx.reply(
    `📋 <b>Реквизиты для оплаты заказа #${orderId}:</b>\n\n` +
    `<code>${escapeHtml(PAYMENT_DETAILS)}</code>\n\n` +
    `💰 Сумма к переводу: <b>${order ? formatMoney(order.amount) : ''}</b>\n` +
    `<i>Нажмите на текст реквизитов выше, чтобы скопировать. После оплаты пришлите чек!</i>`,
    { parse_mode: 'HTML' }
  );
});

// ==========================================
// ОБРАБОТКА ПОЛУЧЕНИЯ ЧЕКА (ФОТО ИЛИ ДОКУМЕНТ)
// ==========================================

bot.on(['photo', 'document'], async (ctx) => {
  const userId = ctx.from.id;
  const state = userStates.get(userId);

  // Обработка фото для массовой рассылки администратором
  if (state?.type === 'ADMIN_BROADCAST_AWAIT_MESSAGE' && isAdmin(userId)) {
    let photoFileId = null;
    if (ctx.message.photo && ctx.message.photo.length > 0) {
      photoFileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else if (ctx.message.document && ctx.message.document.mime_type?.startsWith('image/')) {
      photoFileId = ctx.message.document.file_id;
    }

    const captionText = ctx.message.caption ? ctx.message.caption.trim() : '';

    if (!photoFileId) {
      return ctx.reply('⚠️ Для рассылки с фото отправьте изображение (фотографию или картинку).');
    }

    userStates.set(userId, {
      type: 'ADMIN_BROADCAST_CONFIRM',
      broadcastMessage: captionText,
      photoFileId: photoFileId,
    });

    const previewMsg =
      `👁 <b>ПРЕДПРОСМОТР РАССЫЛКИ (С ФОТО):</b>\n\n` +
      (captionText || '<i>(без текстовой подписи)</i>') + '\n\n' +
      `<i>Кнопка «📦 Перейти в каталог» будет прикреплена автоматически.</i>\n\n` +
      `Отправить всем активным клиентам?`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🚀 Запустить рассылку', 'admin_broadcast_confirm')],
      [Markup.button.callback('❌ Отмена', 'admin_panel')],
    ]);

    await ctx.replyWithPhoto(photoFileId, {
      caption: previewMsg,
      parse_mode: 'HTML',
      ...keyboard,
    });
    return;
  }

  const draft = ctx.session?.draftOrder || state?.draftOrder;

  let orderId = state?.type === 'AWAITING_RECEIPT' ? state.orderId : null;

  if (!draft && !orderId) {
    const pendingOrder = db.getActivePendingOrderByUser(userId);
    if (pendingOrder) {
      orderId = pendingOrder.id;
    }
  }

  if (!draft && !orderId) {
    return ctx.reply('ℹ️ У вас нет активных заказов, ожидающих чек. Чтобы оформить заказ, перейдите в каталог:', getMainMenuKeyboard(userId));
  }

  let fileId = null;
  let fileUniqueId = null;
  if (ctx.message.photo && ctx.message.photo.length > 0) {
    const photoObj = ctx.message.photo[ctx.message.photo.length - 1];
    fileId = photoObj.file_id;
    fileUniqueId = photoObj.file_unique_id;
  } else if (ctx.message.document) {
    fileId = ctx.message.document.file_id;
    fileUniqueId = ctx.message.document.file_unique_id;
  }

  if (!fileId) {
    return ctx.reply('⚠️ Не удалось распознать файл чека. Пожалуйста, отправьте скриншот в виде фото или документа.');
  }

  // 1. ЗАЩИТА ОТ ПОВТОРНЫХ ЧЕКОВ И ФРОДА
  if (fileUniqueId) {
    const existingOrder = db.findOrderByReceiptUniqueId(fileUniqueId);
    if (existingOrder && (!orderId || existingOrder.id !== orderId)) {
      // Отклоняем отправку
      await safeSendMessage(
        ctx.telegram,
        userId,
        `❌ <b>Этот чек уже был использован в системе. Попытка обмана зафиксирована.</b>\n\n` +
        `Пожалуйста, отправьте реальный чек об оплате.`
      );

      // Уведомляем администратора(ов) о попытке мошенничества
      const buyerUsername = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'клиент');
      const fraudAlert =
        `🚨 <b>ВНИМАНИЕ! ПОПЫТКА ФРОДА (ПОВТОРНЫЙ ЧЕК)!</b>\n\n` +
        `👤 <b>Пользователь:</b> ${escapeHtml(buyerUsername)} (ID: <code>${userId}</code>)\n` +
        `🔍 <b>Ранее использован в заказе:</b> #${existingOrder.id} (создан: ${existingOrder.created_at}, сумма: ${formatMoney(existingOrder.amount)})\n` +
        `🔑 <b>file_unique_id:</b> <code>${escapeHtml(fileUniqueId)}</code>\n\n` +
        `Заблокировать пользователя?`;

      const fraudKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`🚫 В бан покупателя (ID: ${userId})`, `ban_user_${userId}_order_${orderId || 0}`)],
      ]);

      const adminIds = getAdminIds();
      for (const adminId of adminIds) {
        try {
          await safeSendMessage(ctx.telegram, adminId, fraudAlert, fraudKeyboard);
        } catch (e) {}
      }
      return;
    }
  }

  let order = null;

  if (draft) {
    const product = db.getProductById(draft.productId);
    if (!product || product.is_hidden) {
      if (ctx.session) {
        ctx.session.draftOrder = null;
        ctx.session.step = null;
      }
      userStates.delete(userId);
      return ctx.reply('❌ К сожалению, этот товар больше недоступен для покупки.', Markup.inlineKeyboard([[Markup.button.callback('📦 Каталог товаров', 'catalog')]]));
    }

    const isFlex = draft.productType === 'FLEXIBLE';
    if (!isFlex && !product.is_unlimited) {
      const availableStock = db.getAvailableStock(product);
      if (draft.quantity > availableStock) {
        if (ctx.session) {
          ctx.session.draftOrder = null;
          ctx.session.step = null;
        }
        userStates.delete(userId);
        return ctx.reply(`❌ К сожалению, на складе осталось только ${availableStock} шт. Попробуйте оформить заново.`, Markup.inlineKeyboard([[Markup.button.callback('📦 Каталог товаров', 'catalog')]]));
      }
    }

    // Запись в таблицу orders происходит ТОЛЬКО в момент отправки чека
    const totalAmount = draft.totalPrice || draft.amount;
    order = db.createOrder({
      user_id: userId,
      username: ctx.from.username || ctx.from.first_name || 'клиент',
      product_id: draft.productId,
      amount: totalAmount,
      base_amount: draft.baseAmount || totalAmount,
      fee_amount: draft.feeAmount || 0,
      fee_percent: draft.feePercent || 0,
      fee_type: draft.feeType || 'PERCENT',
      fee_value: draft.feeValue || 0,
      quantity: draft.quantity || 1,
      buyer_comment: draft.buyerComment || null,
      reserve: !isFlex,
      promo_id: draft.promoId || null,
      promo_code: draft.promoCode || null,
      discount_amount: draft.discountAmount || 0,
    });

    if (ctx.session) {
      ctx.session.draftOrder = null;
      ctx.session.step = null;
    }
    userStates.delete(userId);
  } else {
    order = db.getOrderById(orderId);
    if (!order || order.status !== 'PENDING') {
      userStates.delete(userId);
      return ctx.reply('⚠️ Этот заказ уже оплачен, отменен или находится на проверке.');
    }
    userStates.delete(userId);
  }

  // Прикрепляем квитанцию с сохранением уникального хеша
  db.attachReceipt(order.id, fileId, fileUniqueId);
  order = db.getOrderById(order.id) || order;

  const isFlex = order.product_type === 'FLEXIBLE';

  const userPromoLine = order.promo_code && order.discount_amount > 0
    ? `🎟 Скидка по промокоду: <b>-${formatMoney(order.discount_amount)}</b> (<code>${escapeHtml(order.promo_code)}</code>)\n`
    : '';

  await safeSendMessage(
    ctx.telegram,
    userId,
    `✅ <b>Чек принят, ожидайте подтверждения администратором.</b>\n\n` +
    `Номер заказа: <b>#${order.id}</b>\n` +
    `Лот: <b>${escapeHtml(order.product_name)}</b> (${formatMoney(order.amount)})\n` +
    userPromoLine + '\n' +
    (isFlex ? `Ваша заявка передана администратору на исполнение. 🚀` : `Товар забронирован за вами. Как только платеж подтвердится, вы получите его в этот чат! 🚀`),
    getMainMenuKeyboard(userId)
  );

  const adminIds = getAdminIds();
  if (adminIds.length > 0) {
    const buyerUsername = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'клиент');
    const deliveryTypeLabel = isFlex
      ? '💳 Пополнение баланса'
      : (order.product_delivery_type === 'MANUAL' ? '✍️ Ручная выдача' : '⚡ Автовыдача');

    const commentBlock = order.buyer_comment
      ? `\n💬 <b>Реквизиты/логин:</b> <code>${escapeHtml(order.buyer_comment)}</code>`
      : '\n💬 <b>Комментарий:</b> <i>(не указан)</i>';

    let adminDetails = '';
    if (isFlex && order.base_amount) {
      const prod = order.product_id ? db.getProductById(order.product_id) : null;
      const curSym = (prod?.currency_symbol && String(prod.currency_symbol).trim()) || '₽';
      let feeLine = '0% (без комиссии)';
      if (order.fee_amount > 0) {
        if (order.fee_type === 'FIXED') {
          feeLine = `+${formatMoney(order.fee_value || order.fee_amount, '₽')} (фикс.)`;
        } else {
          feeLine = `+${order.fee_percent}% (+${formatMoney(order.fee_amount, '₽')})`;
        }
      }
      adminDetails =
        `📥 <b>К зачислению клиенту:</b> <b>${formatMoney(order.base_amount, curSym)}</b>\n` +
        `📊 <b>Комиссия:</b> ${feeLine}\n` +
        `💰 <b>Сумма перевода:</b> <b>${formatMoney(order.amount, '₽')}</b>\n`;
    } else {
      adminDetails =
        `🔢 <b>Количество:</b> <b>${order.quantity} шт.</b>\n` +
        `💰 <b>Сумма к получению:</b> <b>${formatMoney(order.amount)}</b>\n`;
    }

    let promoLine = '';
    if (order.promo_code && order.discount_amount > 0) {
      promoLine = `🎟 <b>Промокод:</b> <code>${escapeHtml(order.promo_code)}</code> (-${formatMoney(order.discount_amount)})\n`;
    }

    const adminCaption =
      `🔔 <b>НОВЫЙ ЧЕК НА ПРОВЕРКУ!</b>\n\n` +
      `🧾 <b>Заказ:</b> #${order.id}\n` +
      `👤 <b>Покупатель:</b> ${escapeHtml(buyerUsername)} (ID: <code>${userId}</code>)\n` +
      `📦 <b>Лот:</b> ${escapeHtml(order.product_name)}\n` +
      adminDetails +
      promoLine +
      `🚚 <b>Тип:</b> ${deliveryTypeLabel}` +
      commentBlock;

    // В клавиатуру админа добавляем кнопку [ 🚫 В бан ]
    const adminKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(`🟩 Подтвердить #${order.id}`, `admin_approve_${order.id}`),
        Markup.button.callback(`🟥 Отклонить #${order.id}`, `admin_reject_${order.id}`),
      ],
      [
        Markup.button.callback(`🚫 В бан`, `ban_user_${userId}_order_${order.id}`),
      ],
    ]);

    for (const adminId of adminIds) {
      try {
        if (ctx.message.photo) {
          await ctx.telegram.sendPhoto(adminId, fileId, {
            caption: adminCaption,
            parse_mode: 'HTML',
            ...adminKeyboard,
          });
        } else {
          await ctx.telegram.sendDocument(adminId, fileId, {
            caption: adminCaption,
            parse_mode: 'HTML',
            ...adminKeyboard,
          });
        }
      } catch (err) {
        console.error(`[ADMIN NOTIFY ERROR] Не удалось переслать чек админу ${adminId}:`, err.message);
      }
    }
  }
});

// ==========================================
// ЛОГИКА АДМИНИСТРАТОРА: ПОДТВЕРЖДЕНИЕ И ОТКЛОНЕНИЕ
// ==========================================

bot.action(/^admin_approve_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });

  const orderId = Number(ctx.match[1]);
  const order = db.getOrderById(orderId);

  if (!order) {
    return ctx.answerCbQuery('❌ Заказ не найден', { show_alert: true });
  }

  if (order.status !== 'PENDING') {
    await ctx.answerCbQuery(`⚠️ Заказ уже обработан (статус: ${order.status})`, { show_alert: true });
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [[Markup.button.callback(`ℹ️ Обработано (${order.status})`, 'noop')]] });
    } catch (e) {}
    return;
  }

  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[Markup.button.callback('✅ Обработано (Подтвержден)', 'noop')]],
      });
    }
  } catch (e) {}

  await ctx.answerCbQuery('Выполняется выдача...');

  const deliveryResult = db.processProductDeliveryOnApproval(order.id);
  db.approveOrder(order.id, deliveryResult.givenKeys || null);

  const isFlex = order.product_type === 'FLEXIBLE';
  const isManual = isFlex || order.product_delivery_type === 'MANUAL';
  const qty = order.quantity || 1;

  if (isManual) {
    const customerMsg =
      `🎉 <b>Оплата подтверждена!</b>\n\n` +
      `Продавец свяжется с вами или пополнит ваш аккаунт в ближайшее время.\n\n` +
      `📦 <b>Лот:</b> ${escapeHtml(order.product_name)} ${isFlex ? '' : `(${qty} шт.)`}\n` +
      `🧾 <b>Номер заказа:</b> #${order.id}\n` +
      `💰 <b>Оплачено:</b> ${formatMoney(order.amount)}\n\n` +
      `Если у вас срочный вопрос: ${escapeHtml(SUPPORT_CONTACT)}`;

    await safeSendMessage(ctx.telegram, order.user_id, customerMsg);

    const buyerLink = order.username
      ? `@${order.username.replace(/^@/, '')}`
      : `<a href="tg://user?id=${order.user_id}">покупателю (ID: ${order.user_id})</a>`;

    const adminNotice =
      `✅ <b>Заказ #${order.id} успешно подтвержден!</b>\n\n` +
      `✍️ <b>Лот с ручной выдачей / пополнением:</b> ${escapeHtml(order.product_name)}\n` +
      `👤 Напишите ${buyerLink} и передайте товар / выполните пополнение.\n` +
      (order.buyer_comment ? `💬 Реквизиты покупателя: <code>${escapeHtml(order.buyer_comment)}</code>\n\n` : '\n') +
      `Вы также можете отправить сообщение покупателю прямо через бота:`;

    const adminKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✍️ Отправить данные покупателю через бота', `admin_manual_send_${order.id}`)],
    ]);

    await safeSendMessage(ctx.telegram, ctx.from.id, adminNotice, adminKeyboard);
  } else {
    // AUTO
    const keysText = deliveryResult.givenKeys || order.product_secret_data || 'Данные выданы администратором.';

    const customerMsg =
      `🎉 <b>Ваш заказ #${order.id} успешно оплачен и выполнен!</b>\n\n` +
      `📦 <b>Товар:</b> ${escapeHtml(order.product_name)}\n` +
      `🔢 <b>Количество:</b> ${qty} шт.\n` +
      `💰 <b>Сумма:</b> ${formatMoney(order.amount)}\n\n` +
      `🔑 <b>ВАШИ КЛЮЧИ / ДАННЫЕ (${qty} шт.):</b>\n` +
      `<pre>${escapeHtml(keysText)}</pre>\n\n` +
      `<i>Все выданные ключи также всегда сохранены в разделе «🛍 Мои покупки».</i>\n` +
      `Благодарим за покупку! ❤️`;

    await safeSendMessage(ctx.telegram, order.user_id, customerMsg);

    const remainingText = deliveryResult.isSoldOut
      ? '⚠️ <b>0 шт. (Все ключи распроданы, товар скрыт)</b>'
      : `<b>${deliveryResult.remainingStock} шт.</b>`;

    await safeSendMessage(
      ctx.telegram,
      ctx.from.id,
      `✅ <b>Заказ #${order.id} успешно подтвержден!</b>\n\n` +
      `📦 Товар: <b>${escapeHtml(order.product_name)}</b> (${qty} шт.)\n` +
      `🔑 Выдано ключей: <b>${qty} шт.</b>\n` +
      `<pre>${escapeHtml(keysText)}</pre>\n` +
      `📊 Остаток на складе: ${remainingText}\n` +
      `👤 Покупатель: ID <code>${order.user_id}</code>`
    );
  }
});

bot.action('noop', async (ctx) => {
  await ctx.answerCbQuery('Этот заказ уже был обработан.');
});

bot.action(/^admin_manual_send_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });

  const orderId = Number(ctx.match[1]);
  const order = db.getOrderById(orderId);
  if (!order) return ctx.answerCbQuery('❌ Заказ не найден', { show_alert: true });

  await ctx.answerCbQuery();
  userStates.set(userId, {
    type: 'ADMIN_AWAITING_MANUAL_SEND',
    orderId: orderId,
  });

  await safeSendMessage(
    ctx.telegram,
    userId,
    `✍️ <b>Отправка данных покупателю (Заказ #${orderId}):</b>\n\n` +
    `Введите текст (ключ, логин:пароль, скриншот или сообщение), который бот немедленно перешлет покупателю:`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_panel')]])
  );
});

bot.action(/^admin_reject_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });

  const orderId = Number(ctx.match[1]);
  const order = db.getOrderById(orderId);
  if (!order) return ctx.answerCbQuery('❌ Заказ не найден', { show_alert: true });

  if (order.status !== 'PENDING') {
    await ctx.answerCbQuery(`⚠️ Заказ уже обработан (статус: ${order.status})`, { show_alert: true });
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [[Markup.button.callback(`ℹ️ Обработано (${order.status})`, 'noop')]] });
    } catch (e) {}
    return;
  }

  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[Markup.button.callback('❌ Обработано (Отклонен)', 'noop')]],
      });
    }
  } catch (e) {}

  await ctx.answerCbQuery();
  userStates.set(userId, {
    type: 'ADMIN_AWAITING_REJECT_REASON',
    orderId: orderId,
  });

  const promptText =
    `🟥 <b>Отклонение заказа #${orderId}:</b>\n\n` +
    `Отправьте в чат <b>причину отказа</b> (например: <i>«Оплата не поступила на счет»</i>) или нажмите кнопку ниже:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Отклонить без комментария', `admin_reject_confirm_${orderId}`)],
    [Markup.button.callback('◀️ Назад в админку', 'admin_panel')],
  ]);

  await safeSendMessage(ctx.telegram, userId, promptText, keyboard);
});

bot.action(/^admin_reject_confirm_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });

  const orderId = Number(ctx.match[1]);
  const order = db.getOrderById(orderId);
  if (!order) return ctx.answerCbQuery('❌ Заказ не найден', { show_alert: true });

  await ctx.answerCbQuery('Заказ отклонен');
  userStates.delete(userId);

  const defaultReason = 'Оплата не подтверждена или не поступила на счет.';
  db.rejectOrder(orderId, defaultReason);

  await safeSendMessage(
    ctx.telegram,
    order.user_id,
    `❌ <b>Ваш заказ #${order.id} был отклонен.</b>\n\n` +
    `📦 Товар: ${escapeHtml(order.product_name)} (${formatMoney(order.amount)})\n` +
    `⚠️ Причина: <i>${defaultReason}</i>\n\n` +
    `Бронь товара снята. Если произошла ошибка: ${escapeHtml(SUPPORT_CONTACT)}`
  );

  await safeSendMessage(ctx.telegram, userId, `❌ Заказ #${orderId} отклонен без комментария. Бронь товара снята.`);
});

// Возобновление оплаты активного заказа
bot.action(/^resume_order_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const orderId = Number(ctx.match[1]);
  const order = db.getOrderById(orderId);
  if (!order || order.user_id !== ctx.from.id || order.status !== 'PENDING') {
    return safeEditMessage(
      ctx,
      '❌ Заказ не найден или уже закрыт.',
      Markup.inlineKeyboard([[Markup.button.callback('◀️ В каталог', 'menu_catalog')]])
    );
  }

  userStates.set(ctx.from.id, {
    type: 'AWAITING_RECEIPT',
    orderId: order.id,
  });

  await sendPaymentInstructions(ctx, order);
});

// Обработка кнопки [ 🚫 В бан ] (из проверки чека или админ-панели)
bot.action(/^ban_user_(\d+)(?:_order_(\d+))?$/, async (ctx) => {
  const adminId = ctx.from.id;
  if (!isAdmin(adminId)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });

  const targetUserId = Number(ctx.match[1]);
  const orderId = ctx.match[2] ? Number(ctx.match[2]) : null;

  // Заносим в черный список
  db.addToBlacklist(
    targetUserId,
    orderId ? `Блокировка из заказа #${orderId} (повторный чек / фрод)` : 'Блокировка администратором'
  );

  if (orderId) {
    db.releaseProductReservation(orderId);
    db.cancelOrder(orderId, 'Пользователь заблокирован администратором за попытку фрода');
  }

  userStates.delete(targetUserId);

  await ctx.answerCbQuery('🚫 Пользователь добавлен в черный список!', { show_alert: true });

  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[Markup.button.callback('🚫 Заблокирован в системе', 'noop')]],
      });
    }
  } catch (e) {}

  await safeSendMessage(
    ctx.telegram,
    targetUserId,
    `⛔ <b>Вы заблокированы в этом магазине.</b>\n\n` +
    (orderId ? `Заказ #${orderId} аннулирован.\n` : '') +
    `Доступ ко всем покупкам закрыт.\n` +
    `Контакты поддержки: ${escapeHtml(SUPPORT_CONTACT)}`
  );

  await safeSendMessage(
    ctx.telegram,
    adminId,
    `🚫 <b>Пользователь (ID: <code>${targetUserId}</code>) успешно заблокирован!</b>\n` +
    (orderId ? `Заказ #${orderId} отменен, зарезервированный товар возвращен в продажу.` : '')
  );
});

// ==========================================
// ОБРАБОТКА ЗАПРОСА НАЛИЧИЯ АДМИНИСТРАТОРОМ
// ==========================================

// Админ: Товар есть в наличии -> Выставить счет (PENDING + 15 мин бронь)
bot.action(/^admin_stock_yes_(\d+)$/, async (ctx) => {
  const adminId = ctx.from.id;
  if (!isAdmin(adminId)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });

  const orderId = Number(ctx.match[1]);
  const order = db.getOrderById(orderId);

  if (!order) {
    return ctx.answerCbQuery('❌ Заказ не найден', { show_alert: true });
  }

  if (order.status !== 'CHECKING_STOCK') {
    await ctx.answerCbQuery(`⚠️ Заявка уже обработана (статус: ${order.status})`, { show_alert: true });
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[Markup.button.callback(`ℹ️ Обработано (${order.status})`, 'noop')]],
      });
    } catch (e) {}
    return;
  }

  const product = db.getProductById(order.product_id);
  const qty = Math.max(1, order.quantity || 1);

  // Резервируем товар на складе, если он не безлимитный
  if (product && !product.is_unlimited) {
    db.reserveProductStock(product.id, qty);
  }

  // Переводим статус в PENDING и включаем флаг брони
  db.db.prepare(`
    UPDATE orders 
    SET status = 'PENDING', is_reserved = 1, created_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `).run(orderId);

  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[Markup.button.callback('✅ Наличие подтверждено (Счет выставлен)', 'noop')]],
      });
    }
  } catch (e) {}

  await ctx.answerCbQuery('Наличие подтверждено! Покупателю отправлен счет.');

  // Устанавливаем пользователю состояние ожидания чека
  userStates.set(order.user_id, {
    type: 'AWAITING_RECEIPT',
    orderId: order.id,
  });

  // Отправляем покупателю реквизиты и уведомление с 15-минутным таймером
  const buyerPaymentText =
    `🟢 <b>Товар в наличии! Продавец подтвердил заявку.</b>\n\n` +
    `Счет на оплату сформирован. Товар забронирован за вами на <b>15 минут</b>.\n\n` +
    `📦 <b>Лот:</b> ${escapeHtml(order.product_name)} (${qty} шт.)\n` +
    `💰 <b>Сумма к оплате:</b> <b>${formatMoney(order.amount)}</b>\n\n` +
    `💳 <b>Реквизиты для перевода (нажмите для копирования):</b>\n` +
    `<code>${escapeHtml(PAYMENT_DETAILS)}</code>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📸 <b>ИНСТРУКЦИЯ ПО ОПЛАТЕ:</b>\n` +
    `1. Переведите точную сумму <b>${formatMoney(order.amount)}</b> по указанным реквизитам.\n` +
    `2. Сохраните чек или квитанцию перевода.\n` +
    `3. <b>Отправьте фото или файл чека в этот чат!</b>\n\n` +
    `⏳ <i>У вас есть 15 минут для оплаты и загрузки чека.</i>`;

  const buyerPaymentKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Скопировать реквизиты', `copy_payment_details_${order.id}`)],
    [Markup.button.callback('🛑 Отменить заказ', `cancel_order_${order.id}`)],
  ]);

  await safeSendMessage(ctx.telegram, order.user_id, buyerPaymentText, buyerPaymentKeyboard);
});

// Админ: Товара нет в наличии -> OUT_OF_STOCK
bot.action(/^admin_stock_no_(\d+)$/, async (ctx) => {
  const adminId = ctx.from.id;
  if (!isAdmin(adminId)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });

  const orderId = Number(ctx.match[1]);
  const order = db.getOrderById(orderId);

  if (!order) {
    return ctx.answerCbQuery('❌ Заказ не найден', { show_alert: true });
  }

  if (order.status !== 'CHECKING_STOCK') {
    await ctx.answerCbQuery(`⚠️ Заявка уже обработана (статус: ${order.status})`, { show_alert: true });
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[Markup.button.callback(`ℹ️ Обработано (${order.status})`, 'noop')]],
      });
    } catch (e) {}
    return;
  }

  // Обновляем статус заказа на OUT_OF_STOCK
  db.db.prepare(`
    UPDATE orders 
    SET status = 'OUT_OF_STOCK', seller_comment = 'Товара нет в наличии у поставщика/на складе' 
    WHERE id = ?
  `).run(orderId);

  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[Markup.button.callback('🔴 Нет в наличии (Отклонено)', 'noop')]],
      });
    }
  } catch (e) {}

  await ctx.answerCbQuery('Отклонено: товара нет в наличии');

  // Уведомляем покупателя
  const buyerOutOfStockText =
    `🔴 <b>К сожалению, товара сейчас нет в наличии.</b>\n\n` +
    `Продавец проверил склад: лот <b>${escapeHtml(order.product_name)}</b> временно закончился.\n\n` +
    `Вы можете выбрать другой доступный товар в каталоге или обратиться в поддержку.`;

  const buyerOutOfStockKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📦 Каталог товаров', 'catalog')],
  ]);

  await safeSendMessage(ctx.telegram, order.user_id, buyerOutOfStockText, buyerOutOfStockKeyboard);
});

// ==========================================
// АДМИН-ПАНЕЛЬ (/admin)
// ==========================================

async function showAdminPanel(ctx) {
  const stats = db.getDatabaseStats();
  const blacklistedCount = db.getAllBlacklisted().length;
  const promoCount = db.getAllPromocodes().length;
  const categoriesCount = db.getAllCategories ? db.getAllCategories().length : 0;
  const usersCount = db.getUsersCount ? db.getUsersCount() : { total: 0, active: 0, blocked: 0 };

  const text =
    `👑 <b>Панель администратора магазина:</b>\n\n` +
    `📊 <b>СТАТИСТИКА:</b>\n` +
    `• Всего заказов: <b>${stats.totalOrders}</b>\n` +
    `• Ожидают проверки: <b>${stats.pendingOrders}</b>\n` +
    `• Выполнено: <b>${stats.approvedCount}</b>\n` +
    `• Возвратов (Refund): <b>${stats.refundedOrders || 0}</b>\n` +
    `• 💰 Общая выручка: <b>${formatMoney(stats.totalRevenue)}</b>\n\n` +
    `👥 <b>ПОЛЬЗОВАТЕЛИ:</b>\n` +
    `• Всего в базе: <b>${usersCount.total}</b> (Активных: <b>${usersCount.active}</b> | Заблокировали: <b>${usersCount.blocked}</b>)\n\n` +
    `📦 <b>ТОВАРЫ И БЕЗОПАСНОСТЬ:</b>\n` +
    `• На витрине: <b>${stats.availableProducts}</b> | Продано/Скрыто: <b>${stats.soldProducts}</b>\n` +
    `• 📁 Категорий товаров: <b>${categoriesCount}</b>\n` +
    `• 🎟 Промокодов: <b>${promoCount}</b>\n` +
    `• 🚫 В черном списке: <b>${blacklistedCount} польз.</b>\n\n` +
    `Выберите действие:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Добавить товар', 'admin_add_product')],
    [
      Markup.button.callback('📦 Управление товарами', 'admin_products_list'),
      Markup.button.callback('📁 Управление категориями', 'admin_categories_menu'),
    ],
    [
      Markup.button.callback('🎟 Управление промокодами', 'admin_promocodes_menu'),
      Markup.button.callback('📢 Рассылка пользователям', 'admin_broadcast_start'),
    ],
    [Markup.button.callback('🔄 Заказы / Возврат', 'admin_orders_menu')],
    [Markup.button.callback('🛑 Сбросить активный заказ пользователя', 'admin_reset_user_order')],
    [
      Markup.button.callback(`🚫 Черный список (${blacklistedCount})`, 'admin_blacklist_menu'),
      Markup.button.callback('💾 Скачать бэкап', 'admin_backup_db'),
    ],
    [Markup.button.callback('◀️ В главное меню', 'main_menu')],
  ]);

  if (ctx.callbackQuery) {
    await safeEditMessage(ctx, text, keyboard);
  } else {
    await safeSendMessage(ctx.telegram, ctx.from.id, text, keyboard);
  }
}

bot.action('admin_panel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  userStates.delete(ctx.from.id);
  await showAdminPanel(ctx);
});

// ==========================================
// УПРАВЛЕНИЕ ПРОМОКОДАМИ (АДМИН-ПАНЕЛЬ)
// ==========================================

async function showAdminPromoList(ctx, page = 1) {
  const promos = db.getAllPromocodes();
  if (promos.length === 0) {
    const text =
      `🎟 <b>Список промокодов</b>\n\n` +
      `В базе пока нет созданных промокодов.\n` +
      `Нажмите «Создать промокод», чтобы настроить скидочный купон:`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Создать промокод', 'admin_promo_create')],
      [Markup.button.callback('◀️ В меню промокодов', 'admin_promocodes_menu')],
    ]);

    if (ctx.callbackQuery) {
      return safeEditMessage(ctx, text, keyboard);
    }
    return safeSendMessage(ctx.telegram, ctx.from.id, text, keyboard);
  }

  const PAGE_SIZE = 5;
  const totalPages = Math.ceil(promos.length / PAGE_SIZE) || 1;
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const currentPromos = promos.slice(startIdx, startIdx + PAGE_SIZE);

  let text = `🎟 <b>Список промокодов (Стр. ${currentPage}/${totalPages}):</b>\n\n`;

  const buttons = [];

  for (const p of currentPromos) {
    const discStr = p.discount_type === 'FIXED' ? `${formatMoney(p.discount_value)}` : `${p.discount_value}%`;
    const statusStr = p.is_active ? '🟢 Активен' : '🔴 Отключен';
    const usesStr = `${p.current_uses} / ${p.max_uses > 0 ? p.max_uses : '∞'}`;
    const targetStr = p.target_type === 'SPECIFIC' && p.target_product_name ? p.target_product_name : 'Все товары';
    const minStr = p.min_order_amount > 0 ? `от ${formatMoney(p.min_order_amount)}` : 'без мин. суммы';

    text +=
      `🔖 <b>${escapeHtml(p.code)}</b> (-${discStr})\n` +
      `• Статус: <b>${statusStr}</b> | Использовано: <b>${usesStr}</b>\n` +
      `• Таргет: <i>${escapeHtml(targetStr)}</i> (${minStr})\n\n`;

    buttons.push([
      Markup.button.callback(
        p.is_active ? `🔴 Выключить` : `🟢 Включить`,
        `admin_promo_toggle_${p.id}_${currentPage}`
      ),
      Markup.button.callback(`🗑 Удалить ${p.code}`, `admin_promo_del_${p.id}_${currentPage}`),
    ]);
  }

  const navRow = [];
  if (currentPage > 1) {
    navRow.push(Markup.button.callback('⬅️ Назад', `admin_promo_list_page_${currentPage - 1}`));
  }
  if (currentPage < totalPages) {
    navRow.push(Markup.button.callback('Вперед ➡️', `admin_promo_list_page_${currentPage + 1}`));
  }
  if (navRow.length > 0) {
    buttons.push(navRow);
  }

  buttons.push([
    Markup.button.callback('➕ Создать промокод', 'admin_promo_create'),
    Markup.button.callback('◀️ В меню промокодов', 'admin_promocodes_menu'),
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  if (ctx.callbackQuery) {
    return safeEditMessage(ctx, text, keyboard);
  }
  return safeSendMessage(ctx.telegram, ctx.from.id, text, keyboard);
}

bot.action('admin_promocodes_menu', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  userStates.delete(ctx.from.id);

  const promos = db.getAllPromocodes();
  const activeCount = promos.filter((p) => p.is_active).length;

  const text =
    `🎟 <b>Управление промокодами</b>\n\n` +
    `• Всего промокодов: <b>${promos.length}</b>\n` +
    `• Активных: <b>${activeCount}</b>\n\n` +
    `Вы можете создавать промокоды со скидкой в рублях или процентах, настраивать лимиты активаций, таргетинг и ограничения по сумме.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Создать промокод', 'admin_promo_create')],
    [Markup.button.callback('📋 Список промокодов', 'admin_promo_list')],
    [Markup.button.callback('◀️ В админ-панель', 'admin_panel')],
  ]);

  if (ctx.callbackQuery) {
    await safeEditMessage(ctx, text, keyboard);
  } else {
    await safeSendMessage(ctx.telegram, ctx.from.id, text, keyboard);
  }
});

bot.action('admin_promo_list', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  userStates.delete(ctx.from.id);
  await showAdminPromoList(ctx, 1);
});

bot.action(/^admin_promo_list_page_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const page = Number(ctx.match[1]) || 1;
  await showAdminPromoList(ctx, page);
});

bot.action(/^admin_promo_toggle_(\d+)_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  const promoId = Number(ctx.match[1]);
  const page = Number(ctx.match[2]) || 1;
  const updated = db.togglePromocodeActive(promoId);
  await ctx.answerCbQuery(updated?.is_active ? 'Промокод активирован' : 'Промокод отключен');
  return showAdminPromoList(ctx, page);
});

bot.action(/^admin_promo_del_(\d+)_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  const promoId = Number(ctx.match[1]);
  const page = Number(ctx.match[2]) || 1;
  db.deletePromocode(promoId);
  await ctx.answerCbQuery('Промокод удален');
  return showAdminPromoList(ctx, page);
});

bot.action('admin_promo_cancel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery('Создание промокода отменено');
  userStates.delete(ctx.from.id);
  return showAdminPromoList(ctx, 1);
});

bot.action('admin_promo_create', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();

  userStates.set(ctx.from.id, {
    type: 'ADMIN_PROMO_WIZARD',
    step: 'CODE',
    data: {},
  });

  const text =
    `🎟 <b>Создание промокода (Шаг 1 из 6)</b>\n\n` +
    `Введите кодовое слово промокода (например: <code>NEW2026</code> или <code>SALE100</code>):\n` +
    `<i>Только буквы и цифры. Регистр не имеет значения (автоматически верхний).</i>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Отмена', 'admin_promo_cancel')],
  ]);

  if (ctx.callbackQuery) {
    await safeEditMessage(ctx, text, keyboard);
  } else {
    await safeSendMessage(ctx.telegram, ctx.from.id, text, keyboard);
  }
});

bot.action(/^admin_promo_type_(FIXED|PERCENT)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userStates.get(userId);

  if (!state || state.type !== 'ADMIN_PROMO_WIZARD' || state.step !== 'DISCOUNT_TYPE') {
    return ctx.reply('⚠️ Сессия создания промокода устарела.', Markup.inlineKeyboard([[Markup.button.callback('В меню промокодов', 'admin_promocodes_menu')]]));
  }

  const type = ctx.match[1];
  state.data.discount_type = type;
  state.step = 'DISCOUNT_VALUE';

  const promptText =
    `🎟 <b>Создание промокода (Шаг 3 из 6)</b>\n\n` +
    `Код: <b>${state.data.code}</b>\n` +
    `Тип скидки: <b>${type === 'FIXED' ? '💵 Фиксированная сумма (₽)' : '📊 Процент (%)'}</b>\n\n` +
    (type === 'FIXED'
      ? `Введите размер фиксированной скидки в рублях (например: <code>100</code> или <code>50</code>):`
      : `Введите размер процентной скидки от 1 до 99% (например: <code>15</code> или <code>10</code>):`);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Отмена', 'admin_promo_cancel')],
  ]);

  if (ctx.callbackQuery) {
    await safeEditMessage(ctx, promptText, keyboard);
  } else {
    await safeSendMessage(ctx.telegram, userId, promptText, keyboard);
  }
});

bot.action(/^admin_promo_target_(ALL|SPECIFIC)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userStates.get(userId);

  if (!state || state.type !== 'ADMIN_PROMO_WIZARD' || state.step !== 'TARGET_TYPE') {
    return ctx.reply('⚠️ Сессия создания промокода устарела.', Markup.inlineKeyboard([[Markup.button.callback('В меню промокодов', 'admin_promocodes_menu')]]));
  }

  const targetType = ctx.match[1];

  if (targetType === 'ALL') {
    state.data.target_type = 'ALL';
    state.data.target_product_id = null;
    state.step = 'MAX_USES';

    const promptText =
      `🎟 <b>Создание промокода (Шаг 5 из 6)</b>\n\n` +
      `Укажите количество доступных использований.\n` +
      `Введите число (например: <code>50</code>) или <b>0</b> для бесконечного количества:`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('❌ Отмена', 'admin_promo_cancel')],
    ]);

    if (ctx.callbackQuery) {
      await safeEditMessage(ctx, promptText, keyboard);
    } else {
      await safeSendMessage(ctx.telegram, userId, promptText, keyboard);
    }
    return;
  }

  // SPECIFIC: выбор товара из списка
  state.data.target_type = 'SPECIFIC';
  state.step = 'TARGET_PRODUCT';

  const products = db.getAllProducts();
  if (products.length === 0) {
    state.data.target_type = 'ALL';
    state.data.target_product_id = null;
    state.step = 'MAX_USES';
    await ctx.reply('⚠️ В магазине еще нет товаров. Промокод будет действовать на все товары.');
    return ctx.reply(
      `🎟 <b>Создание промокода (Шаг 5 из 6)</b>\n\nУкажите количество доступных использований (число или 0 для бесконечного):`,
      Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_promo_cancel')]])
    );
  }

  const buttons = products.map((p) => [
    Markup.button.callback(`${p.is_hidden ? '👁‍🗨 ' : ''}${p.name}`, `admin_promo_pick_prod_${p.id}`),
  ]);
  buttons.push([Markup.button.callback('❌ Отмена', 'admin_promo_cancel')]);

  const promptText =
    `🎯 <b>Создание промокода (Шаг 4 из 6)</b>\n\n` +
    `Выберите товар, для которого действует промокод:`;

  if (ctx.callbackQuery) {
    await safeEditMessage(ctx, promptText, Markup.inlineKeyboard(buttons));
  } else {
    await safeSendMessage(ctx.telegram, userId, promptText, Markup.inlineKeyboard(buttons));
  }
});

bot.action(/^admin_promo_pick_prod_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userStates.get(userId);

  if (!state || state.type !== 'ADMIN_PROMO_WIZARD' || state.step !== 'TARGET_PRODUCT') {
    return ctx.reply('⚠️ Сессия создания промокода устарела.', Markup.inlineKeyboard([[Markup.button.callback('В меню промокодов', 'admin_promocodes_menu')]]));
  }

  const prodId = Number(ctx.match[1]);
  const product = db.getProductById(prodId);
  state.data.target_product_id = prodId;
  state.step = 'MAX_USES';

  const promptText =
    `🎟 <b>Создание промокода (Шаг 5 из 6)</b>\n\n` +
    `Выбран товар: <b>${product ? escapeHtml(product.name) : '#' + prodId}</b>\n\n` +
    `Укажите количество доступных использований.\n` +
    `Введите число (например: <code>50</code>) или <b>0</b> для бесконечного количества:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Отмена', 'admin_promo_cancel')],
  ]);

  if (ctx.callbackQuery) {
    await safeEditMessage(ctx, promptText, keyboard);
  } else {
    await safeSendMessage(ctx.telegram, userId, promptText, keyboard);
  }
});

// Меню управления черным списком
bot.action('admin_blacklist_menu', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();

  const list = db.getAllBlacklisted();

  let text = `🚫 <b>Черный список (Заблокированные пользователи):</b>\n\n`;
  if (!list || list.length === 0) {
    text += `<i>Список пуст. В магазине нет заблокированных пользователей.</i>`;
  } else {
    text += `Всего заблокировано: <b>${list.length}</b>\n\n`;
  }

  const buttons = [];
  for (const item of list.slice(0, 10)) {
    text += `👤 ID: <code>${item.user_id}</code> | ${escapeHtml(item.reason || 'Бан')}\n📅 <i>${item.created_at}</i>\n\n`;
    buttons.push([Markup.button.callback(`🔓 Разбанить ID: ${item.user_id}`, `admin_unban_${item.user_id}`)]);
  }

  buttons.push([Markup.button.callback('◀️ Назад в админку', 'admin_panel')]);

  await safeEditMessage(ctx, text, Markup.inlineKeyboard(buttons));
});

// Разблокировка пользователя
bot.action(/^admin_unban_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  const targetUserId = Number(ctx.match[1]);

  db.removeFromBlacklist(targetUserId);
  await ctx.answerCbQuery(`Пользователь ${targetUserId} разблокирован!`, { show_alert: true });

  await safeSendMessage(
    ctx.telegram,
    targetUserId,
    `✅ <b>Ваш аккаунт был разблокирован администратором.</b>\nТеперь вы снова можете совершать покупки в магазине.`
  );

  return showAdminPanel(ctx);
});

// Скачивание бэкапа базы данных через кнопку
bot.action('admin_backup_db', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery('Формирование бэкапа...');

  const dbPath = path.join(process.cwd(), 'shop.db');
  if (!fs.existsSync(dbPath)) {
    return ctx.reply('❌ Файл базы данных shop.db не найден на сервере.');
  }

  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    await ctx.replyWithDocument(
      { source: dbPath, filename: `shop_backup_${dateStr}.db` },
      {
        caption:
          `💾 <b>Резервная копия SQLite (shop.db)</b>\n\n` +
          `📅 Дата: ${new Date().toLocaleString('ru-RU')}\n` +
          `🔒 Экспорт по запросу администратора`,
        parse_mode: 'HTML',
      }
    );
  } catch (err) {
    console.error('Ошибка отправки бэкапа из кнопки:', err);
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

// ==========================================
// МАССОВАЯ РАССЫЛКА ПОЛЬЗОВАТЕЛЯМ (/broadcast)
// ==========================================

let activeBroadcast = null; // Флаг/объект идущей рассылки

// Запуск мастера рассылки из кнопки в админке
bot.action('admin_broadcast_start', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();

  if (activeBroadcast) {
    return safeEditMessage(
      ctx,
      `⏳ <b>В данный момент уже выполняется рассылка!</b>\n` +
      `Прогресс: отправлено ${activeBroadcast.sent}/${activeBroadcast.total}.\nПожалуйста, дождитесь ее завершения.`,
      Markup.inlineKeyboard([[Markup.button.callback('◀️ В админ-панель', 'admin_panel')]])
    );
  }

  const usersCount = db.getUsersCount ? db.getUsersCount() : { total: 0, active: 0, blocked: 0 };

  userStates.set(ctx.from.id, {
    type: 'ADMIN_BROADCAST_AWAIT_MESSAGE',
  });

  const text =
    `📢 <b>Массовая рассылка по пользователям бота</b>\n\n` +
    `👥 Получателей: <b>${usersCount.active} активных</b> (из ${usersCount.total} всего в базе)\n\n` +
    `📝 <b>Отправьте текст или фото с подписью</b>, которое хотите разослать всем клиентам.\n\n` +
    `<i>Поддерживается форматирование HTML (жирный, курсив, ссылки). К рассылке автоматически добавится кнопка в каталог.</i>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Отмена', 'admin_panel')],
  ]);

  await safeEditMessage(ctx, text, keyboard);
});

// Команда /broadcast для быстрого вызова админом
bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  if (activeBroadcast) {
    return ctx.reply(`⏳ Уже идет рассылка (${activeBroadcast.sent}/${activeBroadcast.total}). Дождитесь окончания.`);
  }

  const usersCount = db.getUsersCount ? db.getUsersCount() : { total: 0, active: 0, blocked: 0 };
  userStates.set(ctx.from.id, { type: 'ADMIN_BROADCAST_AWAIT_MESSAGE' });

  await ctx.reply(
    `📢 <b>Массовая рассылка:</b>\n` +
    `👥 Активных пользователей: <b>${usersCount.active}</b>\n\n` +
    `Пришлите сообщение (текст или фото с описанием), которое необходимо разослать.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_panel')]]),
    }
  );
});

// Подтверждение и запуск рассылки
bot.action('admin_broadcast_confirm', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();

  const state = userStates.get(ctx.from.id);
  if (!state || state.type !== 'ADMIN_BROADCAST_CONFIRM') {
    return safeEditMessage(
      ctx,
      '⚠️ Данные для рассылки устарели. Начните заново.',
      Markup.inlineKeyboard([[Markup.button.callback('◀️ В админ-панель', 'admin_panel')]])
    );
  }

  if (activeBroadcast) {
    return ctx.reply('⏳ Рассылка уже запущена.');
  }

  const { broadcastMessage, photoFileId } = state;
  userStates.delete(ctx.from.id);

  const users = db.getAllActiveUsers ? db.getAllActiveUsers() : [];
  if (!users || users.length === 0) {
    return safeEditMessage(
      ctx,
      'ℹ️ В базе данных нет активных пользователей для рассылки.',
      Markup.inlineKeyboard([[Markup.button.callback('◀️ В админ-панель', 'admin_panel')]])
    );
  }

  const adminChatId = ctx.from.id;
  activeBroadcast = {
    total: users.length,
    sent: 0,
    failed: 0,
    blocked: 0,
  };

  const statusMsg = await ctx.reply(
    `🚀 <b>Рассылка запущена!</b>\n👥 Получателей: <b>${users.length}</b>\n⏳ Скорость: ~30 сообщ./сек (защита от лимитов TG)...`,
    { parse_mode: 'HTML' }
  );

  // Запуск фоновой отправки с задержкой 35 мс (~28-30 сообщений в секунду)
  (async () => {
    let sentCount = 0;
    let blockedCount = 0;
    let failedCount = 0;

    const broadcastKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📦 Перейти в каталог', 'menu_catalog')],
    ]);

    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      try {
        if (photoFileId) {
          await ctx.telegram.sendPhoto(u.user_id, photoFileId, {
            caption: broadcastMessage,
            parse_mode: 'HTML',
            ...broadcastKeyboard,
          });
        } else {
          await ctx.telegram.sendMessage(u.user_id, broadcastMessage, {
            parse_mode: 'HTML',
            ...broadcastKeyboard,
          });
        }
        sentCount++;
      } catch (err) {
        const errMsg = err?.message || err?.description || '';
        if (
          errMsg.includes('bot was blocked by the user') ||
          errMsg.includes('user is deactivated') ||
          errMsg.includes('chat not found')
        ) {
          blockedCount++;
          if (db.markUserBlocked) {
            db.markUserBlocked(u.user_id);
          }
        } else if (errMsg.includes('Too Many Requests')) {
          // Если поймали лимит - делаем паузу на retry_after
          const waitSec = err?.parameters?.retry_after || 2;
          await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
          i--; // Повторяем отправку этому пользователю
          continue;
        } else {
          failedCount++;
        }
      }

      activeBroadcast.sent = sentCount;
      activeBroadcast.blocked = blockedCount;
      activeBroadcast.failed = failedCount;

      // Задержка между отправками для соблюдения лимитов Telegram (<= 30 сообщений/сек)
      await new Promise((resolve) => setTimeout(resolve, 35));
    }

    activeBroadcast = null;

    const reportText =
      `✅ <b>Рассылка успешно завершена!</b>\n\n` +
      `📊 <b>ИТОГИ:</b>\n` +
      `• Всего адресатов: <b>${users.length}</b>\n` +
      `• Успешно доставлено: <b>${sentCount}</b>\n` +
      `• Заблокировали бота (помечены неактивными): <b>${blockedCount}</b>\n` +
      `• Другие ошибки: <b>${failedCount}</b>`;

    try {
      await ctx.telegram.sendMessage(adminChatId, reportText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('⚙️ В админ-панель', 'admin_panel')]]),
      });
    } catch (e) {
      console.error('Ошибка отправки отчета рассылки:', e);
    }
  })();
});

// ==========================================
// СБРОС АКТИВНЫХ ЗАКАЗОВ ПОЛЬЗОВАТЕЛЯ (АДМИН)
// ==========================================

bot.action('admin_reset_user_order', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();

  userStates.set(ctx.from.id, { type: 'ADMIN_AWAITING_RESET_USER_ID' });

  const activeUsers = db.getUsersWithActiveOrders();

  let text =
    `🛑 <b>Сброс активного заказа пользователя</b>\n\n` +
    `При сбросе все зависшие заказы со статусом <code>PENDING</code> принудительно переводятся в <code>CANCELLED</code>, а забронированные товары возвращаются на склад.\n\n` +
    `✏️ <b>Отправьте Telegram ID пользователя сообщением в чат</b>, либо выберите из списка пользователей с активными заказами ниже:`;

  const buttons = [];

  if (activeUsers && activeUsers.length > 0) {
    for (const u of activeUsers.slice(0, 10)) {
      const name = u.username ? `@${u.username}` : `ID: ${u.user_id}`;
      buttons.push([
        Markup.button.callback(
          `🛑 ${name} (заказов: ${u.pending_count})`,
          `admin_do_reset_${u.user_id}`
        ),
      ]);
    }
  } else {
    text += `\n\n<i>Сейчас в базе данных нет пользователей с активными PENDING-заказами.</i>`;
  }

  buttons.push([Markup.button.callback('◀️ Назад в админку', 'admin_panel')]);

  await safeEditMessage(ctx, text, Markup.inlineKeyboard(buttons));
});

bot.action(/^admin_do_reset_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  const targetUserId = Number(ctx.match[1]);

  const cancelledCount = db.resetUserPendingOrders(targetUserId);
  userStates.delete(targetUserId);

  await ctx.answerCbQuery(`Сброшено заказов: ${cancelledCount}`, { show_alert: true });

  await safeSendMessage(
    ctx.telegram,
    targetUserId,
    `ℹ️ <b>Ваши активные заказы были сброшены администратором.</b>\nТеперь вы можете оформить новый заказ в каталоге.`,
    getMainMenuKeyboard(targetUserId)
  );

  await safeEditMessage(
    ctx,
    `✅ <b>Сброс выполнен успешно!</b>\n\n` +
    `• Пользователь ID: <code>${targetUserId}</code>\n` +
    `• Переведено в CANCELLED заказов: <b>${cancelledCount}</b>\n\n` +
    `Пользователь теперь может беспрепятственно выбирать любые товары и суммы в каталоге.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🛑 Сбросить еще', 'admin_reset_user_order')],
      [Markup.button.callback('◀️ В админ-панель', 'admin_panel')],
    ])
  );
});

// Команда /resetorder [user_id]
bot.command(['resetorder', 'reset_order'], async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length > 1) {
    const targetUserId = Number(parts[1].replace(/\D/g, ''));
    if (!targetUserId) {
      return ctx.reply('⚠️ Укажите числовой ID пользователя. Пример: <code>/resetorder 123456789</code>', { parse_mode: 'HTML' });
    }

    const cancelledCount = db.resetUserPendingOrders(targetUserId);
    userStates.delete(targetUserId);

    await safeSendMessage(
      ctx.telegram,
      targetUserId,
      `ℹ️ <b>Ваши активные заказы были сброшены администратором.</b>\nТеперь вы можете оформить новый заказ в каталоге.`,
      getMainMenuKeyboard(targetUserId)
    );

    return ctx.reply(
      `✅ <b>Успешно сброшено активных заказов: ${cancelledCount}</b> для пользователя <code>${targetUserId}</code>.`,
      { parse_mode: 'HTML' }
    );
  }

  // Если без параметров - открываем меню выбора/ввода
  userStates.set(ctx.from.id, { type: 'ADMIN_AWAITING_RESET_USER_ID' });
  const activeUsers = db.getUsersWithActiveOrders();
  let text =
    `🛑 <b>Сброс активного заказа пользователя</b>\n\n` +
    `Отправьте Telegram ID пользователя сообщением в ответ, либо выберите из списка:`;

  const buttons = [];
  if (activeUsers && activeUsers.length > 0) {
    for (const u of activeUsers.slice(0, 10)) {
      const name = u.username ? `@${u.username}` : `ID: ${u.user_id}`;
      buttons.push([Markup.button.callback(`🛑 ${name} (${u.pending_count})`, `admin_do_reset_${u.user_id}`)]);
    }
  }
  buttons.push([Markup.button.callback('◀️ В админ-панель', 'admin_panel')]);

  await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

// ==========================================
// СПИСОК И РЕДАКТИРОВАНИЕ ТОВАРОВ В /admin
// ==========================================

bot.action('admin_products_list', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();

  const products = db.getAllProducts();

  if (!products || products.length === 0) {
    return safeEditMessage(
      ctx,
      `📦 <b>В базе нет добавленных товаров.</b>`,
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить первый товар', 'admin_add_product')],
        [Markup.button.callback('◀️ Назад в админку', 'admin_panel')],
      ])
    );
  }

  const buttons = products.map((p) => {
    let stockLabel = '';
    if (p.product_type === 'FLEXIBLE') {
      const curSym = (p.currency_symbol && String(p.currency_symbol).trim()) || '₽';
      stockLabel = `от ${formatMoney(p.min_amount, curSym)}`;
    } else if (p.is_sold || (!p.is_unlimited && p.stock <= 0)) {
      stockLabel = 'Закончился';
    } else if (p.is_unlimited) {
      stockLabel = 'В наличии: ∞';
    } else {
      stockLabel = `${p.stock} шт`;
    }

    const hideIcon = p.is_hidden ? '🙈 ' : '';
    const typeIcon = p.emoji ? `${p.emoji} ` : (p.product_type === 'FLEXIBLE' ? '💳 ' : '📦 ');
    const nameShort = p.name.length > 14 ? p.name.slice(0, 12) + '..' : p.name;
    const buttonText = `${hideIcon}${typeIcon}#${p.id} ${nameShort} (${stockLabel})`;

    return [Markup.button.callback(buttonText, `admin_manage_prod_${p.id}`)];
  });

  buttons.push([Markup.button.callback('➕ Добавить товар', 'admin_add_product')]);
  buttons.push([Markup.button.callback('◀️ Назад в админку', 'admin_panel')]);

  const text =
    `📦 <b>Управление товарами (всего: ${products.length}):</b>\n\n` +
    `Нажмите на любой лот для редактирования:`;

  await safeEditMessage(ctx, text, Markup.inlineKeyboard(buttons));
});

/**
 * Отрисовка карточки управления товаром в админ-панели
 */
export async function renderProductManagementCard(ctx, productId) {
  const product = db.getProductById(productId);

  if (!product) {
    return safeEditMessage(ctx, '❌ Товар не найден.', Markup.inlineKeyboard([[Markup.button.callback('Назад', 'admin_products_list')]]));
  }

  const statusText = product.is_hidden
    ? '🙈 <b>Скрыт с витрины</b> (покупатели его не видят)'
    : '🟢 <b>Активен на витрине</b>';

  if (product.product_type === 'FLEXIBLE') {
    const feeLabel = formatFeeLabel(product);
    const curSym = (product.currency_symbol && String(product.currency_symbol).trim()) || '₽';
    const rate = product.exchange_rate || 1.0;
    const decimalsLabel = product.allow_decimals
      ? `🪙 Разрешены копейки / дробные (100.50 ${curSym})`
      : `🔢 Только целые числа (100, 500 ${curSym})`;

    const catName = product.category_id && db.getCategoryById(product.category_id)
      ? db.getCategoryById(product.category_id).name
      : 'Без категории (Общая)';

    const cardText =
      `💳 <b>Карточка управления лотом #${product.id} (Пополнение баланса)</b>\n\n` +
      `✨ <b>Эмодзи:</b> ${product.emoji || '📦'}\n` +
      `🏷 <b>Название:</b> ${escapeHtml(product.name)}\n` +
      `📁 <b>Категория:</b> ${escapeHtml(catName)}\n` +
      `📝 <b>Описание:</b> ${escapeHtml(product.description || 'нет')}\n` +
      `💱 <b>Символ валюты:</b> <b>${curSym}</b>\n` +
      `📈 <b>Курс:</b> <b>1 ${curSym} = ${rate} ₽</b>\n` +
      `📉 <b>Мин. сумма:</b> <b>${formatMoney(product.min_amount, curSym)}</b>\n` +
      `📈 <b>Макс. сумма:</b> <b>${formatMoney(product.max_amount, curSym)}</b>\n` +
      `📊 <b>Тип комиссии:</b> <b>${product.fee_type === 'FIXED' ? 'Фиксированная наценка (₽)' : 'Процент от суммы (%)'}</b>\n` +
      `💰 <b>Размер комиссии:</b> <b>${feeLabel}</b>\n` +
      `⚙️ <b>Формат сумм клиента:</b> <b>${decimalsLabel}</b>\n` +
      `📌 <b>Статус:</b> ${statusText}\n\n` +
      `Выберите параметр для изменения:`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✏️ Название', `admin_edit_name_${product.id}`),
        Markup.button.callback('📝 Описание', `admin_edit_desc_${product.id}`),
      ],
      [
        Markup.button.callback(`✨ Эмодзи (${product.emoji || '📦'})`, `admin_edit_emoji_${product.id}`),
        Markup.button.callback(`💱 Валюта (${curSym})`, `admin_edit_cur_${product.id}`),
      ],
      [
        Markup.button.callback(`📈 Курс (1 ${curSym} = ${rate} ₽)`, `admin_edit_rate_${product.id}`),
      ],
      [
        Markup.button.callback('📉 Мин. сумма', `admin_edit_min_${product.id}`),
        Markup.button.callback('📈 Макс. сумма', `admin_edit_max_${product.id}`),
      ],
      [
        Markup.button.callback(`📊 Комиссия (${feeLabel})`, `admin_edit_fee_${product.id}`),
        Markup.button.callback(
          `🪙 Формат: ${product.allow_decimals ? 'Копейки' : 'Целые'}`,
          `admin_toggle_decimals_${product.id}`
        ),
      ],
      [
        Markup.button.callback('📁 Сменить категорию', `admin_edit_cat_${product.id}`),
      ],
      [
        Markup.button.callback(product.is_hidden ? '👁 Показать' : '🙈 Скрыть', `admin_toggle_hide_${product.id}`),
        Markup.button.callback('🗑 Удалить лот', `admin_delete_prod_${product.id}`),
      ],
      [Markup.button.callback('◀️ Назад к списку лотов', 'admin_products_list')],
    ]);

    return safeEditMessage(ctx, cardText, keyboard);
  }

  // FIXED
  const isSoldOut = Boolean(product.is_sold || (!product.is_unlimited && product.stock <= 0));
  const deliveryText = product.delivery_type === 'MANUAL' ? '✍️ Ручная выдача' : '⚡ Авто-выдача';
  const stockText = product.is_unlimited
    ? 'Бесконечно (∞)'
    : `${product.stock} шт. (Свободно: ${db.getAvailableStock(product)} шт.)`;

  let secretText = '';
  if (product.delivery_type === 'AUTO') {
    const keys = (product.secret_data || '').split('\n').map((k) => k.trim()).filter((k) => k.length > 0);
    secretText = `\n🔑 <b>Ключей в очереди:</b> ${keys.length} шт.\n`;
    if (keys.length > 0) {
      secretText += `<i>Следующий на выдачу:</i> <code>${escapeHtml(keys[0])}</code>\n`;
    }
  }

  const checkStatusLabel = product.requires_availability_check
    ? '🟢 ВКЛ (Запрос наличия перед оплатой)'
    : '⚪ ВЫКЛ (Сразу оплата)';

  const catName = product.category_id && db.getCategoryById(product.category_id)
    ? db.getCategoryById(product.category_id).name
    : 'Без категории (Общая)';

  const cardText =
    `📦 <b>Карточка управления лотом #${product.id} (Штучный товар)</b>\n\n` +
    `🏷 <b>Название:</b> ${escapeHtml(product.name)}\n` +
    `📁 <b>Категория:</b> ${escapeHtml(catName)}\n` +
    `📝 <b>Описание:</b> ${escapeHtml(product.description || 'нет')}\n` +
    `💰 <b>Цена:</b> <b>${formatMoney(product.price)}</b>\n` +
    `🚚 <b>Тип доставки:</b> ${deliveryText}\n` +
    `📊 <b>Остаток на складе:</b> <b>${stockText}</b>\n` +
    `🔒 <b>В брони:</b> <b>${product.reserved_stock || 0} шт.</b>\n` +
    `🔍 <b>Проверка наличия:</b> <b>${checkStatusLabel}</b>\n` +
    `⚙️ <b>Статус:</b> ${statusText}` +
    secretText +
    `\nВыберите параметр для изменения:`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✏️ Изменить название', `admin_edit_name_${product.id}`),
      Markup.button.callback('📝 Изменить описание', `admin_edit_desc_${product.id}`),
    ],
    [
      Markup.button.callback('💰 Изменить цену', `admin_edit_price_${product.id}`),
      Markup.button.callback(`🚚 Тип: ${product.delivery_type === 'AUTO' ? '⚡->✍️' : '✍️->⚡'}`, `admin_toggle_type_${product.id}`),
    ],
    [
      Markup.button.callback(
        `🔍 Проверка наличия: ${product.requires_availability_check ? 'ВКЛ' : 'ВЫКЛ'}`,
        `admin_toggle_req_check_${product.id}`
      ),
    ],
    [
      Markup.button.callback('📁 Сменить категорию', `admin_edit_cat_${product.id}`),
    ],
    [
      Markup.button.callback(product.is_hidden ? '👁 Показать на витрине' : '🙈 Скрыть с витрины', `admin_toggle_hide_${product.id}`),
      Markup.button.callback('➕ Добавить ключи / остаток', `admin_replenish_${product.id}`),
    ],
    [Markup.button.callback('🗑 Удалить лот', `admin_delete_prod_${product.id}`)],
    [Markup.button.callback('◀️ Назад к списку лотов', 'admin_products_list')],
  ]);

  await safeEditMessage(ctx, cardText, keyboard);
}

bot.action(/^admin_manage_prod_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});

  const productId = Number(ctx.match[1]);
  await renderProductManagementCard(ctx, productId);
});

// Редактирование названия
bot.action(/^admin_edit_name_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);

  userStates.set(ctx.from.id, {
    type: 'ADMIN_EDIT_NAME',
    productId: productId,
  });

  await safeEditMessage(
    ctx,
    `✏️ <b>Введите новое название для лота #${productId}:</b>`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin_manage_prod_${productId}`)]])
  );
});

// Редактирование описания
bot.action(/^admin_edit_desc_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);

  userStates.set(ctx.from.id, {
    type: 'ADMIN_EDIT_DESC',
    productId: productId,
  });

  await safeEditMessage(
    ctx,
    `📝 <b>Введите новое описание для лота #${productId}</b> (или отправьте <code>-</code> чтобы оставить пустым):`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin_manage_prod_${productId}`)]])
  );
});

// Редактирование эмодзи (FLEXIBLE / FIXED)
bot.action(/^admin_edit_emoji_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);

  userStates.set(ctx.from.id, {
    type: 'ADMIN_EDIT_EMOJI',
    productId: productId,
  });

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🇷🇺 🇷🇺', `admin_set_emoji_${productId}_🇷🇺`),
      Markup.button.callback('🇰🇿 🇰🇿', `admin_set_emoji_${productId}_🇰🇿`),
      Markup.button.callback('🇹🇷 🇹🇷', `admin_set_emoji_${productId}_🇹🇷`),
      Markup.button.callback('🇺🇦 🇺🇦', `admin_set_emoji_${productId}_🇺🇦`),
    ],
    [
      Markup.button.callback('🇺🇸 🇺🇸', `admin_set_emoji_${productId}_🇺🇸`),
      Markup.button.callback('🎮 🎮', `admin_set_emoji_${productId}_🎮`),
      Markup.button.callback('⭐ ⭐', `admin_set_emoji_${productId}_⭐`),
      Markup.button.callback('📦 📦', `admin_set_emoji_${productId}_📦`),
    ],
    [Markup.button.callback('❌ Отмена', `admin_manage_prod_${productId}`)],
  ]);

  await safeEditMessage(
    ctx,
    `✨ <b>Выберите эмодзи для лота #${productId} или отправьте любой свой эмодзи сообщением:</b>`,
    keyboard
  );
});

bot.action(/^admin_set_emoji_(\d+)_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);
  const emoji = ctx.match[2];
  userStates.delete(ctx.from.id);
  db.updateProductEmoji(productId, emoji);
  await renderProductManagementCard(ctx, productId);
});

// Редактирование валюты (FLEXIBLE)
bot.action(/^admin_edit_cur_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);

  userStates.set(ctx.from.id, {
    type: 'ADMIN_EDIT_CURRENCY',
    productId: productId,
  });

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('₽ (Рубли)', `admin_set_cur_${productId}_₽`),
      Markup.button.callback('₸ (Тенге)', `admin_set_cur_${productId}_₸`),
      Markup.button.callback('₺ (Лиры)', `admin_set_cur_${productId}_₺`),
    ],
    [
      Markup.button.callback('$ (USD)', `admin_set_cur_${productId}_$`),
      Markup.button.callback('грн (Гривны)', `admin_set_cur_${productId}_грн`),
      Markup.button.callback('⭐ (Stars)', `admin_set_cur_${productId}_⭐`),
    ],
    [Markup.button.callback('❌ Отмена', `admin_manage_prod_${productId}`)],
  ]);

  await safeEditMessage(
    ctx,
    `💱 <b>Выберите валюту для лота #${productId} или отправьте текстовый символ (например: <code>₸</code>, <code>₺</code>, <code>$</code>, <code>Stars</code>):</b>`,
    keyboard
  );
});

bot.action(/^admin_set_cur_(\d+)_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);
  const cur = ctx.match[2];
  userStates.delete(ctx.from.id);
  db.updateProductCurrency(productId, cur);
  await renderProductManagementCard(ctx, productId);
});

// Редактирование курса конвертации (FLEXIBLE)
bot.action(/^admin_edit_rate_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);
  const product = db.getProductById(productId);
  const curSym = (product?.currency_symbol && String(product.currency_symbol).trim()) || 'ед.';

  userStates.set(ctx.from.id, {
    type: 'ADMIN_EDIT_EXCHANGE_RATE',
    productId: productId,
  });

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('1.0 (Курс 1 к 1 / Рубли)', `admin_set_rate_${productId}_1`)],
    [Markup.button.callback('❌ Отмена', `admin_manage_prod_${productId}`)],
  ]);

  await safeEditMessage(
    ctx,
    `📈 <b>Курс конвертации для лота #${productId}</b>\n\n` +
    `Укажите, сколько <b>рублей (₽)</b> стоит <b>1 ${curSym}</b>.\n\n` +
    `<i>Примеры:</i>\n` +
    `• 1 ₸ = 0.20 ₽ -> введите <code>0.20</code>\n` +
    `• 1 $ = 92.50 ₽ -> введите <code>92.50</code>\n` +
    `• 1 ₺ = 2.85 ₽ -> введите <code>2.85</code>\n` +
    `• 1 ⭐ = 1.95 ₽ -> введите <code>1.95</code>\n\n` +
    `Отправьте курс числом сообщением в чат:`,
    keyboard
  );
});

bot.action(/^admin_set_rate_(\d+)_([\d\.]+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);
  const rate = parseFloat(ctx.match[2]) || 1.0;
  userStates.delete(ctx.from.id);
  db.updateProductExchangeRate(productId, rate);
  await renderProductManagementCard(ctx, productId);
});

// Редактирование цены
bot.action(/^admin_edit_price_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);

  userStates.set(ctx.from.id, {
    type: 'ADMIN_EDIT_PRICE',
    productId: productId,
  });

  await safeEditMessage(
    ctx,
    `💰 <b>Введите новую цену в рублях (например: <code>499.99</code> или <code>1,02</code>):</b>`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin_manage_prod_${productId}`)]])
  );
});

// Редактирование мин. суммы (FLEXIBLE)
bot.action(/^admin_edit_min_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);

  userStates.set(ctx.from.id, {
    type: 'ADMIN_EDIT_MIN_AMOUNT',
    productId: productId,
  });

  await safeEditMessage(
    ctx,
    `📉 <b>Введите новую минимальную сумму пополнения в рублях (например: <code>100</code> или <code>50.50</code>):</b>`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin_manage_prod_${productId}`)]])
  );
});

// Редактирование макс. суммы (FLEXIBLE)
bot.action(/^admin_edit_max_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);

  userStates.set(ctx.from.id, {
    type: 'ADMIN_EDIT_MAX_AMOUNT',
    productId: productId,
  });

  await safeEditMessage(
    ctx,
    `📈 <b>Введите новую максимальную сумму пополнения в рублях (например: <code>50000</code>):</b>`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin_manage_prod_${productId}`)]])
  );
});

// Редактирование комиссии (меню выбора типа)
bot.action(/^admin_edit_fee_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);
  const product = db.getProductById(productId);

  if (!product) return ctx.reply('❌ Товар не найден.');

  const text =
    `📊 <b>Настройка комиссии/наценки для лота #${productId}</b>\n\n` +
    `Текущая комиссия: <b>${formatFeeLabel(product)}</b>\n` +
    `Тип: <b>${product.fee_type === 'FIXED' ? 'Фиксированная сумма в ₽' : 'Процент от суммы (%)'}</b>\n\n` +
    `Выберите способ начисления комиссии:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📈 В процентах (%)', `admin_set_fee_type_${productId}_PERCENT`)],
    [Markup.button.callback('➕ Фиксированная наценка (₽)', `admin_set_fee_type_${productId}_FIXED`)],
    [Markup.button.callback('❌ Отмена', `admin_manage_prod_${productId}`)],
  ]);

  await safeEditMessage(ctx, text, keyboard);
});

// Выбор типа комиссии и переход к вводу значения
bot.action(/^admin_set_fee_type_(\d+)_(PERCENT|FIXED)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);
  const feeType = ctx.match[2];

  userStates.set(ctx.from.id, {
    type: 'ADMIN_EDIT_FEE_VALUE',
    productId: productId,
    feeType: feeType,
  });

  const prompt = feeType === 'PERCENT'
    ? `📈 <b>Введите процент комиссии/наценки</b> (например: <code>2.5</code> для +2.5% или <code>0</code> без наценки):`
    : `➕ <b>Введите сумму фиксированной наценки в рублях</b> (например: <code>50</code> или <code>1.02</code>):`;

  await safeEditMessage(
    ctx,
    prompt,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin_manage_prod_${productId}`)]])
  );
});

// Переключение разрешения копеек (allow_decimals) в 1 клик
bot.action(/^admin_toggle_decimals_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});
  const productId = Number(ctx.match[1]);
  const product = db.getProductById(productId);

  if (!product) return;

  const newFlag = product.allow_decimals ? 0 : 1;
  db.updateProductAllowDecimals(productId, newFlag);

  await renderProductManagementCard(ctx, productId);
});

// Переключение типа доставки (AUTO <-> MANUAL)
bot.action(/^admin_toggle_type_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});
  const productId = Number(ctx.match[1]);

  db.toggleProductDeliveryType(productId);
  await renderProductManagementCard(ctx, productId);
});

// Переключение проверки наличия перед оплатой (ВКЛ / ВЫКЛ)
bot.action(/^admin_toggle_req_check_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});
  const productId = Number(ctx.match[1]);

  db.toggleProductRequiresAvailabilityCheck(productId);
  await renderProductManagementCard(ctx, productId);
});

// Переключение видимости (Скрыть / Показать)
bot.action(/^admin_toggle_hide_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  // Сразу гасим лоадер на инлайн-кнопке Telegram, чтобы интерфейс не зависал
  await ctx.answerCbQuery().catch(() => {});
  const productId = Number(ctx.match[1]);

  // Обновляем статус видимости в БД
  db.toggleProductVisibility(productId);

  // Мгновенно перерисовываем карточку товара с обновленным статусом и кнопками
  await renderProductManagementCard(ctx, productId);
});

// Пополнение ключей / наличия
bot.action(/^admin_replenish_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();

  const productId = Number(ctx.match[1]);
  const product = db.getProductById(productId);
  if (!product) return ctx.reply('❌ Товар не найден.');

  if (product.delivery_type === 'AUTO') {
    userStates.set(ctx.from.id, {
      type: 'ADMIN_REPLENISH_AUTO_KEYS',
      productId: product.id,
    });

    const promptText =
      `➕ <b>Пополнение ключей (AUTO) для лота #${product.id}: «${escapeHtml(product.name)}»</b>\n\n` +
      `Текущий остаток: <b>${product.stock} шт.</b>\n\n` +
      `Отправьте новые ключи/аккаунты (каждый с новой строки). Они добавятся в очередь выдачи:`;

    await safeEditMessage(
      ctx,
      promptText,
      Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin_manage_prod_${product.id}`)]])
    );
  } else {
    userStates.set(ctx.from.id, {
      type: 'ADMIN_REPLENISH_MANUAL_STOCK',
      productId: product.id,
    });

    const promptText =
      `➕ <b>Пополнение наличия (MANUAL) для лота #${product.id}: «${escapeHtml(product.name)}»</b>\n\n` +
      `Текущее наличие: <b>${product.is_unlimited ? 'Бесконечно (∞)' : product.stock + ' шт.'}</b>\n\n` +
      `Введите количество для добавления (например <code>10</code>) или напишите <code>inf</code> для бесконечного лота:`;

    await safeEditMessage(
      ctx,
      promptText,
      Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin_manage_prod_${product.id}`)]])
    );
  }
});

// Удаление лота
bot.action(/^admin_delete_prod_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  const productId = Number(ctx.match[1]);

  db.deleteProduct(productId);
  await ctx.answerCbQuery('Товар удален', { show_alert: true });

  await safeEditMessage(
    ctx,
    `🗑️ Товар #${productId} успешно удален из магазина!`,
    Markup.inlineKeyboard([[Markup.button.callback('◀️ К списку товаров', 'admin_products_list')]])
  );
});

// ==========================================
// СИСТЕМА ВОЗВРАТОВ (REFUND) ДЛЯ АДМИНИСТРАТОРА
// ==========================================

bot.action('admin_orders_menu', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();

  const orders = db.getAllOrders({ limit: 15 });

  const text =
    `🔄 <b>История заказов и оформление возвратов (REFUND):</b>\n\n` +
    `Здесь отображаются последние заказы. Вы можете выбрать заказ из списка или найти его по номеру:`;

  const buttons = [];

  buttons.push([Markup.button.callback('🔍 Найти заказ по номеру', 'admin_search_order')]);

  orders.slice(0, 10).forEach((ord) => {
    let icon = '⏳';
    if (ord.status === 'APPROVED') icon = '✅';
    if (ord.status === 'REJECTED') icon = '❌';
    if (ord.status === 'REFUNDED') icon = '🔄';

    const shortName = ord.product_name ? (ord.product_name.length > 15 ? ord.product_name.slice(0, 13) + '..' : ord.product_name) : 'Товар';
    const label = `${icon} #${ord.id} ${shortName} (${formatMoney(ord.amount)})`;
    buttons.push([Markup.button.callback(label, `admin_view_order_${ord.id}`)]);
  });

  buttons.push([Markup.button.callback('◀️ Назад в админку', 'admin_panel')]);

  await safeEditMessage(ctx, text, Markup.inlineKeyboard(buttons));
});

bot.action('admin_search_order', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();

  userStates.set(ctx.from.id, { type: 'ADMIN_SEARCH_ORDER_ID' });

  await safeEditMessage(
    ctx,
    `🔍 <b>Поиск заказа:</b>\n\nОтправьте в чат номер заказа (например: <code>12</code>):`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_orders_menu')]])
  );
});

bot.action(/^admin_view_order_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();

  const orderId = Number(ctx.match[1]);
  const order = db.getOrderById(orderId);

  if (!order) {
    return safeEditMessage(ctx, '❌ Заказ не найден.', Markup.inlineKeyboard([[Markup.button.callback('Назад', 'admin_orders_menu')]]));
  }

  let statusBadge = '⏳ На проверке чека';
  if (order.status === 'APPROVED') statusBadge = '✅ Выполнен (Оплачен)';
  if (order.status === 'REJECTED') statusBadge = '❌ Отклонен';
  if (order.status === 'REFUNDED') statusBadge = '🔄 Оформлен возврат (REFUND)';

  const buyerText = order.username
    ? `@${order.username.replace(/^@/, '')} (ID: <code>${order.user_id}</code>)`
    : `ID: <code>${order.user_id}</code>`;

  let feeLine = '0% (без комиссии)';
  if (order.fee_amount > 0) {
    feeLine = order.fee_type === 'FIXED'
      ? `+${formatMoney(order.fee_value || order.fee_amount)} (фикс.)`
      : `+${order.fee_percent}% (+${formatMoney(order.fee_amount)})`;
  }

  const amountBlock = (order.product_type === 'FLEXIBLE' && order.base_amount)
    ? `📥 <b>К зачислению клиенту:</b> <b>${formatMoney(order.base_amount)}</b>\n` +
      `📊 <b>Комиссия сервиса:</b> <b>${feeLine}</b>\n` +
      `💰 <b>Итого к оплате:</b> <b>${formatMoney(order.amount)}</b>\n`
    : `💰 <b>Сумма:</b> <b>${formatMoney(order.amount)}</b>\n`;

  let detailsText =
    `🧾 <b>Детали заказа #${order.id}:</b>\n\n` +
    `👤 <b>Покупатель:</b> ${buyerText}\n` +
    `📦 <b>Лот:</b> ${escapeHtml(order.product_name || 'Не указан')}\n` +
    amountBlock +
    `📊 <b>Статус:</b> ${statusBadge}\n` +
    `🕒 <b>Дата:</b> ${order.created_at}\n` +
    (order.buyer_comment ? `💬 <b>Комментарий/логин:</b> <code>${escapeHtml(order.buyer_comment)}</code>\n` : '');

  if (order.delivered_keys) {
    detailsText += `\n🔑 <b>Выданные ключи / данные:</b>\n<pre>${escapeHtml(order.delivered_keys)}</pre>\n`;
  }

  const buttons = [];

  if (order.status === 'APPROVED') {
    buttons.push([Markup.button.callback('🔄 Оформить возврат (REFUND)', `admin_ask_refund_${order.id}`)]);
  }

  buttons.push([Markup.button.callback('◀️ Назад к списку заказов', 'admin_orders_menu')]);

  await safeEditMessage(ctx, detailsText, Markup.inlineKeyboard(buttons));
});

bot.action(/^admin_ask_refund_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();

  const orderId = Number(ctx.match[1]);
  const order = db.getOrderById(orderId);
  if (!order) return ctx.answerCbQuery('Заказ не найден');

  const text =
    `⚠️ <b>Оформление возврата по заказу #${order.id}:</b>\n\n` +
    `Товар: <b>${escapeHtml(order.product_name)}</b>\n` +
    `Сумма возврата: <b>${formatMoney(order.amount)}</b>\n\n` +
    `<b>Вернуть ключи / наличие товара обратно на склад?</b>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Да, вернуть ключи в наличие', `admin_do_refund_${order.id}_yes`)],
    [Markup.button.callback('❌ Нет, списать безвозвратно', `admin_do_refund_${order.id}_no`)],
    [Markup.button.callback('Отмена', `admin_view_order_${order.id}`)],
  ]);

  await safeEditMessage(ctx, text, keyboard);
});

bot.action(/^admin_do_refund_(\d+)_(yes|no)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  const orderId = Number(ctx.match[1]);
  const restock = ctx.match[2] === 'yes';

  try {
    const updated = db.refundOrder(orderId, { restock });
    await ctx.answerCbQuery('Возврат средств оформлен!');

    await safeSendMessage(
      ctx.telegram,
      updated.user_id,
      `🔔 <b>По вашему заказу #${updated.id} оформлен возврат средств.</b>\n\n` +
      `📦 Товар: ${escapeHtml(updated.product_name)}\n` +
      `💰 Сумма к возврату: <b>${formatMoney(updated.amount)}</b>\n\n` +
      `По всем вопросам возврата средств свяжитесь с поддержкой: ${escapeHtml(SUPPORT_CONTACT)}`
    );

    const stockResultText = restock
      ? 'Товар/ключи успешно возвращены в наличие на склад.'
      : 'Товар списан безвозвратно (на склад не возвращен).';

    await safeEditMessage(
      ctx,
      `✅ <b>Возврат по заказу #${updated.id} успешно оформлен!</b>\n\n` +
      `📊 <b>Склад:</b> ${stockResultText}\n` +
      `👤 Покупателю отправлено уведомление о возврате средств.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🧾 Вернуться к заказу', `admin_view_order_${updated.id}`)],
        [Markup.button.callback('◀️ В меню заказов', 'admin_orders_menu')],
      ])
    );
  } catch (err) {
    await ctx.answerCbQuery('Ошибка возврата: ' + err.message, { show_alert: true });
  }
});

// ==========================================
// ПОШАГОВЫЙ МАСТЕР ДОБАВЛЕНИЯ ТОВАРА (WIZARD)
// ==========================================

bot.action('admin_add_product', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  await startWizard(ctx, userStates);
});

bot.action('wizard_back', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const hasPrev = popWizardStep(userStates, ctx.from.id);
  if (!hasPrev) {
    return showAdminPanel(ctx);
  }
  await renderWizardStep(ctx, userStates, true);
});

bot.action('wizard_cancel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery('Мастер отменен');
  userStates.delete(ctx.from.id);
  await showAdminPanel(ctx);
});

bot.action('wizard_type_fixed', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const state = userStates.get(ctx.from.id);
  if (!state) return startWizard(ctx, userStates);

  state.data.product_type = 'FIXED';
  pushWizardStep(userStates, ctx.from.id, 'FIXED_NAME');
  await renderWizardStep(ctx, userStates, true);
});

bot.action('wizard_type_flexible', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const state = userStates.get(ctx.from.id);
  if (!state) return startWizard(ctx, userStates);

  state.data.product_type = 'FLEXIBLE';
  pushWizardStep(userStates, ctx.from.id, 'FLEX_EMOJI');
  await renderWizardStep(ctx, userStates, true);
});

bot.action(/^wizard_flex_emoji_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const state = userStates.get(ctx.from.id);
  if (!state) return;
  state.data.emoji = ctx.match[1];
  pushWizardStep(userStates, ctx.from.id, 'FLEX_NAME');
  await renderWizardStep(ctx, userStates, true);
});

bot.action(/^wizard_flex_cur_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const state = userStates.get(ctx.from.id);
  if (!state) return;
  state.data.currency_symbol = ctx.match[1];
  pushWizardStep(userStates, ctx.from.id, 'FLEX_RATE');
  await renderWizardStep(ctx, userStates, true);
});

bot.action(/^wizard_flex_rate_([\d\.]+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const state = userStates.get(ctx.from.id);
  if (!state) return;
  state.data.exchange_rate = parseFloat(ctx.match[1]) || 1.0;
  pushWizardStep(userStates, ctx.from.id, 'FLEX_DESC');
  await renderWizardStep(ctx, userStates, true);
});

bot.action(/^wizard_cat_select_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const catId = Number(ctx.match[1]);
  const state = userStates.get(ctx.from.id);
  if (!state) return;

  state.data.category_id = catId;
  const nextStep = state.data.product_type === 'FLEXIBLE' ? 'FLEX_RANGE' : 'FIXED_PRICE';
  pushWizardStep(userStates, ctx.from.id, nextStep);
  await renderWizardStep(ctx, userStates, true);
});

bot.action('wizard_cat_none', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const state = userStates.get(ctx.from.id);
  if (!state) return;

  state.data.category_id = null;
  const nextStep = state.data.product_type === 'FLEXIBLE' ? 'FLEX_RANGE' : 'FIXED_PRICE';
  pushWizardStep(userStates, ctx.from.id, nextStep);
  await renderWizardStep(ctx, userStates, true);
});

bot.action('wizard_delivery_auto', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const state = userStates.get(ctx.from.id);
  if (!state) return;

  state.data.delivery_type = 'AUTO';
  pushWizardStep(userStates, ctx.from.id, 'FIXED_KEYS');
  await renderWizardStep(ctx, userStates, true);
});

bot.action('wizard_delivery_manual', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const state = userStates.get(ctx.from.id);
  if (!state) return;

  state.data.delivery_type = 'MANUAL';
  pushWizardStep(userStates, ctx.from.id, 'FIXED_STOCK');
  await renderWizardStep(ctx, userStates, true);
});

bot.action('wizard_check_yes', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery('Требовать подтверждение: ДА');
  const state = userStates.get(ctx.from.id);
  if (!state) return;
  state.data.requires_availability_check = 1;
  pushWizardStep(userStates, ctx.from.id, 'FIXED_CONFIRM');
  await renderWizardStep(ctx, userStates, true);
});

bot.action('wizard_check_no', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery('Требовать подтверждение: НЕТ');
  const state = userStates.get(ctx.from.id);
  if (!state) return;
  state.data.requires_availability_check = 0;
  pushWizardStep(userStates, ctx.from.id, 'FIXED_CONFIRM');
  await renderWizardStep(ctx, userStates, true);
});

bot.action('wizard_toggle_check', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  const state = userStates.get(ctx.from.id);
  if (!state) return;
  state.data.requires_availability_check = state.data.requires_availability_check ? 0 : 1;
  await ctx.answerCbQuery(state.data.requires_availability_check ? 'Проверка наличия ВКЛ' : 'Проверка наличия ВЫКЛ');
  await renderWizardStep(ctx, userStates, true);
});

bot.action('wizard_confirm_save', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery('Сохранение лота...');
  await saveCreatedProduct(ctx, userStates);
});

// Настройка типа комиссии в мастере
bot.action('wizard_fee_type_percent', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const state = userStates.get(ctx.from.id);
  if (!state) return;
  state.data.fee_type = 'PERCENT';
  pushWizardStep(userStates, ctx.from.id, 'FLEX_FEE_VALUE');
  await renderWizardStep(ctx, userStates, true);
});

bot.action('wizard_fee_type_fixed', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const state = userStates.get(ctx.from.id);
  if (!state) return;
  state.data.fee_type = 'FIXED';
  pushWizardStep(userStates, ctx.from.id, 'FLEX_FEE_VALUE');
  await renderWizardStep(ctx, userStates, true);
});

// Настройка формата ввода (копейки / целые) в мастере
bot.action('wizard_decimals_0', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const state = userStates.get(ctx.from.id);
  if (!state) return;
  state.data.allow_decimals = 0;
  pushWizardStep(userStates, ctx.from.id, 'FLEX_CONFIRM');
  await renderWizardStep(ctx, userStates, true);
});

bot.action('wizard_decimals_1', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery();
  const state = userStates.get(ctx.from.id);
  if (!state) return;
  state.data.allow_decimals = 1;
  pushWizardStep(userStates, ctx.from.id, 'FLEX_CONFIRM');
  await renderWizardStep(ctx, userStates, true);
});

// ==========================================
// УПРАВЛЕНИЕ КАТЕГОРИЯМИ ТОВАРОВ (ADMIN)
// ==========================================

bot.action('admin_categories_menu', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});
  userStates.delete(ctx.from.id);

  const categories = db.getAllCategories ? db.getAllCategories() : [];
  const buttons = [];

  categories.forEach((cat) => {
    const res = db.getAvailableProductsByCategory ? db.getAvailableProductsByCategory(cat.id, { page: 1, limit: 1 }) : { total: 0 };
    const count = res.total !== undefined ? res.total : 0;
    buttons.push([
      Markup.button.callback(`📁 ${cat.name} (${count} акт. товаров)`, `admin_manage_cat_${cat.id}`),
    ]);
  });

  buttons.push([Markup.button.callback('➕ Создать категорию', 'admin_create_category')]);
  buttons.push([Markup.button.callback('◀️ Назад в админ-панель', 'admin_panel')]);

  const text =
    `📁 <b>Управление категориями каталога (всего: ${categories.length}):</b>\n\n` +
    `Категории помогают структурировать товары и ускоряют поиск для покупателей.\n` +
    `Нажмите на категорию для управления:`;

  await safeEditMessage(ctx, text, Markup.inlineKeyboard(buttons));
});

bot.action('admin_create_category', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});

  userStates.set(ctx.from.id, { type: 'ADMIN_CREATE_CATEGORY' });

  await safeEditMessage(
    ctx,
    `➕ <b>Создание новой категории товаров:</b>\n\n` +
    `Отправьте в чат название категории (например: <i>«Подписки и сервисы»</i> или <i>«Игровые ключи»</i>):`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_categories_menu')]])
  );
});

bot.action(/^admin_manage_cat_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});

  const catId = Number(ctx.match[1]);
  const cat = db.getCategoryById ? db.getCategoryById(catId) : null;
  if (!cat) {
    return safeEditMessage(
      ctx,
      '❌ Категория не найдена.',
      Markup.inlineKeyboard([[Markup.button.callback('К списку категорий', 'admin_categories_menu')]])
    );
  }

  const res = db.getAvailableProductsByCategory ? db.getAvailableProductsByCategory(catId, { page: 1, limit: 1 }) : { total: 0 };
  const count = res.total !== undefined ? res.total : 0;

  const text =
    `📁 <b>Карточка категории #${cat.id}</b>\n\n` +
    `🏷 <b>Название:</b> <b>${escapeHtml(cat.name)}</b>\n` +
    `📦 <b>Активных товаров в наличии:</b> <b>${count} шт.</b>\n` +
    `🔢 <b>Порядок сортировки:</b> <b>${cat.sort_order || 0}</b>\n\n` +
    `Выберите действие:`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✏️ Переименовать', `admin_edit_cat_name_${cat.id}`),
      Markup.button.callback('🗑 Удалить', `admin_del_cat_confirm_${cat.id}`),
    ],
    [Markup.button.callback('🔢 Порядок сортировки', `admin_edit_cat_sort_${cat.id}`)],
    [Markup.button.callback('◀️ Назад к категориям', 'admin_categories_menu')],
  ]);

  await safeEditMessage(ctx, text, keyboard);
});

bot.action(/^admin_edit_cat_name_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});

  const catId = Number(ctx.match[1]);
  const cat = db.getCategoryById ? db.getCategoryById(catId) : null;
  if (!cat) return ctx.reply('❌ Категория не найдена.');

  userStates.set(ctx.from.id, {
    type: 'ADMIN_EDIT_CAT_NAME',
    catId,
  });

  await safeEditMessage(
    ctx,
    `✏️ <b>Введите новое название для категории «${escapeHtml(cat.name)}»:</b>`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin_manage_cat_${catId}`)]])
  );
});

bot.action(/^admin_edit_cat_sort_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});

  const catId = Number(ctx.match[1]);
  const cat = db.getCategoryById ? db.getCategoryById(catId) : null;
  if (!cat) return ctx.reply('❌ Категория не найдена.');

  userStates.set(ctx.from.id, {
    type: 'ADMIN_EDIT_CAT_SORT',
    catId,
  });

  await safeEditMessage(
    ctx,
    `🔢 <b>Введите порядок сортировки для категории «${escapeHtml(cat.name)}»:</b>\n\n` +
    `Укажите целое число (например: <code>0</code>, <code>1</code>, <code>5</code>). Категории с меньшим числом отображаются первыми.`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin_manage_cat_${catId}`)]])
  );
});

bot.action(/^admin_del_cat_confirm_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});

  const catId = Number(ctx.match[1]);
  const cat = db.getCategoryById ? db.getCategoryById(catId) : null;
  if (!cat) return ctx.reply('❌ Категория не найдена.');

  const text =
    `⚠️ <b>Подтверждение удаления категории:</b>\n\n` +
    `Вы действительно хотите удалить категорию <b>«${escapeHtml(cat.name)}»</b>?\n\n` +
    `<i>Товары из этой категории не будут удалены, а автоматически перейдут в общий список (без категории).</i>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🗑 Да, удалить категорию', `admin_del_cat_${cat.id}`)],
    [Markup.button.callback('❌ Отмена', `admin_manage_cat_${cat.id}`)],
  ]);

  await safeEditMessage(ctx, text, keyboard);
});

bot.action(/^admin_del_cat_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  const catId = Number(ctx.match[1]);

  if (db.deleteCategory) {
    db.deleteCategory(catId);
  }
  await ctx.answerCbQuery('Категория успешно удалена');

  ctx.match = [];
  return bot.handleUpdate({
    ...ctx.update,
    callback_query: {
      ...ctx.callbackQuery,
      data: 'admin_categories_menu',
    },
  });
});

// Назначение категории лоту из карточки товара в админке
bot.action(/^admin_edit_cat_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});

  const productId = Number(ctx.match[1]);
  const product = db.getProductById(productId);
  if (!product) return ctx.reply('❌ Товар не найден.');

  const categories = db.getAllCategories ? db.getAllCategories() : [];
  const buttons = [];

  for (const cat of categories) {
    const isCurrent = product.category_id === cat.id ? ' (текущая)' : '';
    buttons.push([Markup.button.callback(`📁 ${cat.name}${isCurrent}`, `admin_set_prod_cat_${productId}_${cat.id}`)]);
  }

  const isNone = !product.category_id ? ' (текущая)' : '';
  buttons.push([Markup.button.callback(`🌐 Без категории (Общая)${isNone}`, `admin_set_prod_cat_${productId}_none`)]);
  buttons.push([Markup.button.callback('◀️ Назад к лоту', `admin_manage_prod_${productId}`)]);

  await safeEditMessage(
    ctx,
    `📁 <b>Выберите категорию для лота #${productId} «${escapeHtml(product.name)}»:</b>`,
    Markup.inlineKeyboard(buttons)
  );
});

bot.action(/^admin_set_prod_cat_(\d+)_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещен', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});

  const productId = Number(ctx.match[1]);
  const rawCatId = ctx.match[2];
  const catId = rawCatId === 'none' ? null : Number(rawCatId);

  if (db.updateProductCategory) {
    db.updateProductCategory(productId, catId);
  }

  await ctx.answerCbQuery('Категория товара обновлена!');

  // Возвращаемся в карточку товара
  ctx.match = [, String(productId)];
  return bot.handleUpdate({
    ...ctx.update,
    callback_query: {
      ...ctx.callbackQuery,
      data: `admin_manage_prod_${productId}`,
    },
  });
});

// ==========================================
// ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ И FSM
// ==========================================

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  const text = ctx.message.text.trim();

  // Глобальный перехват команды отмены или кнопки "❌ Отмена"
  if (text === '/cancel' || text.toLowerCase() === 'отмена' || text === '❌ Отмена') {
    if (ctx.session) {
      ctx.session.step = null;
      ctx.session.draftOrder = null;
      ctx.session.newProduct = null;
    }
    userStates.delete(userId);
    return ctx.reply('Действие отменено. Главное меню:', getMainMenuKeyboard(userId));
  }

  try {
    // 0. Текстовое сообщение для массовой рассылки администратором
    if (state?.type === 'ADMIN_BROADCAST_AWAIT_MESSAGE' && isAdmin(userId)) {
      if (!text || text.length < 2) {
        return ctx.reply('⚠️ Сообщение для рассылки должно содержать хотя бы 2 символа.');
      }

      userStates.set(userId, {
        type: 'ADMIN_BROADCAST_CONFIRM',
        broadcastMessage: text,
        photoFileId: null,
      });

      const previewMsg =
        `👁 <b>ПРЕДПРОСМОТР РАССЫЛКИ:</b>\n\n` +
        text + '\n\n' +
        `<i>Кнопка «📦 Перейти в каталог» будет прикреплена автоматически к сообщению.</i>\n\n` +
        `Отправить всем активным клиентам?`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Запустить рассылку', 'admin_broadcast_confirm')],
        [Markup.button.callback('❌ Отмена', 'admin_panel')],
      ]);

      return ctx.reply(previewMsg, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...keyboard,
      });
    }

  // 0. Поиск товаров по каталогу
  if (state?.type === 'USER_SEARCH_PRODUCTS') {
    state.query = text;
    return renderCatalogView(ctx, 'search', 1, text);
  }

  // 0.1. Админ создает категорию
  if (state?.type === 'ADMIN_CREATE_CATEGORY' && isAdmin(userId)) {
    userStates.delete(userId);
    const catName = text.trim();
    if (!catName || catName.length < 2) {
      return ctx.reply('⚠️ Название категории должно быть не менее 2 символов.', Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Назад к категориям', 'admin_categories_menu')],
      ]));
    }
    const created = db.createCategory ? db.createCategory({ name: catName }) : null;
    return ctx.reply(
      `✅ <b>Категория «${escapeHtml(catName)}» успешно создана!</b>\n\nТеперь вы можете привязать к ней существующие или новые товары.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📁 К списку категорий', 'admin_categories_menu')],
          [Markup.button.callback('⚙️ В админ-панель', 'admin_panel')],
        ]),
      }
    );
  }

  // 0.2. Админ переименовывает категорию
  if (state?.type === 'ADMIN_EDIT_CAT_NAME' && isAdmin(userId)) {
    const catId = state.catId;
    userStates.delete(userId);
    const newName = text.trim();
    if (!newName || newName.length < 2) {
      return ctx.reply('⚠️ Название категории должно содержать минимум 2 символа.');
    }
    if (db.updateCategory) {
      db.updateCategory(catId, { name: newName });
    }
    return ctx.reply(
      `✅ <b>Категория переименована в «${escapeHtml(newName)}»!</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📁 К карточке категории', `admin_manage_cat_${catId}`)],
          [Markup.button.callback('📋 Список категорий', 'admin_categories_menu')],
        ]),
      }
    );
  }

  // 0.3. Админ меняет сортировку категории
  if (state?.type === 'ADMIN_EDIT_CAT_SORT' && isAdmin(userId)) {
    const catId = state.catId;
    userStates.delete(userId);
    const sortVal = parseInt(text.trim(), 10);
    if (isNaN(sortVal)) {
      return ctx.reply('⚠️ Введите целое число.');
    }
    if (db.updateCategory) {
      db.updateCategory(catId, { sort_order: sortVal });
    }
    return ctx.reply(
      `✅ <b>Порядок сортировки обновлен на ${sortVal}!</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📁 К карточке категории', `admin_manage_cat_${catId}`)],
          [Markup.button.callback('📋 Список категорий', 'admin_categories_menu')],
        ]),
      }
    );
  }

  // 1. Покупатель вводит желаемую сумму пополнения (FLEXIBLE)
  if (state?.type === 'AWAITING_FLEXIBLE_AMOUNT') {
    const product = db.getProductById(state.productId);
    if (!product || product.product_type !== 'FLEXIBLE') {
      userStates.delete(userId);
      return ctx.reply('❌ Услуга не найдена.');
    }

    const validation = validateFlexibleAmount(product, text);
    if (!validation.valid) {
      return ctx.reply(`⚠️ ${validation.error}`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `view_prod_${product.id}_1`)]]),
      });
    }

    const calc = calculateOrderFee(product, validation.amount);

    db.cancelExpiredOrders(20);
    const activeOrder = db.getActiveOrder(userId);
    if (activeOrder) {
      userStates.delete(userId);
      return ctx.reply(
        `⚠️ <b>У вас уже есть активный заказ #${activeOrder.id}!</b>\n\n` +
        `Сумма: <b>${formatMoney(activeOrder.amount)}</b>\n` +
        `Статус: <b>Ожидает проверки администратором</b>\n\n` +
        `Дождитесь проверки текущего заказа перед оформлением нового.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🛍 Мои покупки', 'menu_my_orders')],
            [Markup.button.callback('◀️ В главное меню', 'main_menu')],
          ]),
        }
      );
    }

    const curSym = (product.currency_symbol && String(product.currency_symbol).trim()) || '₽';

    // Сохраняем черновик заказа в сессию:
    if (!ctx.session) ctx.session = {};
    ctx.session.draftOrder = {
      productId: product.id,
      productName: product.name,
      productType: product.product_type,
      deliveryType: product.delivery_type,
      amount: calc.baseAmount,
      totalPrice: calc.totalAmount,
      baseAmount: calc.baseAmount,
      baseRub: calc.baseRub,
      feeAmount: calc.feeAmount,
      feePercent: calc.feePercent,
      feeType: calc.feeType,
      feeValue: calc.feeValue,
      feeBreakdownText: calc.feeBreakdownText,
      currencySymbol: curSym,
      exchangeRate: calc.exchangeRate,
      quantity: 1,
      buyerComment: null,
      step: 'AWAIT_LOGIN',
    };
    ctx.session.step = 'AWAIT_LOGIN';

    userStates.set(userId, {
      type: 'AWAITING_ORDER_COMMENT',
      draftOrder: ctx.session.draftOrder,
    });

    const promptText =
      `💬 <b>Оформление заявки на пополнение:</b>\n\n` +
      `💳 <b>Услуга:</b> ${product.emoji || '💳'} ${escapeHtml(product.name)}\n` +
      `┌ 📥 <b>К зачислению на баланс:</b> <b>${formatMoney(calc.baseAmount, curSym)}</b>` +
      (calc.exchangeRate !== 1 || curSym !== '₽' ? ` (~${formatMoney(calc.baseRub, '₽')})\n` : '\n') +
      `├ 📊 <b>Комиссия сервиса:</b> <b>${calc.feeBreakdownText}</b>\n` +
      `└ 💰 <b>Итого к оплате:</b> <b>${formatMoney(calc.totalAmount, '₽')}</b>\n\n` +
      `Укажите логин или реквизиты вашего аккаунта (например: логин Steam или ID аккаунта):`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🛑 Отменить заказ', 'cancel_order_')],
    ]);

    return ctx.reply(promptText, { parse_mode: 'HTML', ...keyboard });
  }

  // 2. Покупатель вводит точное количество (QTY) для штучного товара
  if (state?.type === 'AWAITING_QTY_INPUT') {
    const inputQty = parseInt(text, 10);
    const productId = state.productId;
    const product = db.getProductById(productId);
    userStates.delete(userId);

    if (!product) return ctx.reply('❌ Товар не найден.');

    const maxStock = db.getAvailableStock(product);
    if (isNaN(inputQty) || inputQty <= 0) {
      return ctx.reply('⚠️ Введите корректное число больше 0.', Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Назад к товару', `view_prod_${productId}_1`)],
      ]));
    }

    let targetQty = inputQty;
    if (!product.is_unlimited && targetQty > maxStock) {
      targetQty = maxStock;
    }

    return renderProductCard(ctx, productId, targetQty);
  }

  // 3. Покупатель вводит комментарий/логин к заказу
  if (state?.type === 'AWAITING_ORDER_COMMENT' || ctx.session?.draftOrder?.step === 'AWAIT_LOGIN') {
    const draft = ctx.session?.draftOrder || state?.draftOrder;
    if (draft) {
      draft.buyerComment = text.trim();
      draft.step = 'AWAITING_RECEIPT';
      if (ctx.session) {
        ctx.session.draftOrder = draft;
        ctx.session.step = 'AWAITING_RECEIPT';
      }
      userStates.set(userId, {
        type: 'AWAITING_RECEIPT',
        draftOrder: draft,
      });

      await sendDraftPaymentInstructions(ctx, draft);
      return;
    }

    const orderId = state?.orderId;
    if (orderId) {
      db.updateOrderBuyerComment(orderId, text);
      userStates.set(userId, {
        type: 'AWAITING_RECEIPT',
        orderId: orderId,
      });
      const order = db.getOrderById(orderId);
      await sendPaymentInstructions(ctx, order);
      return;
    }
  }

  // 4. Пошаговый мастер создания товара (WIZARD)
  if (state?.type === 'ADMIN_WIZARD' && isAdmin(userId)) {
    const { step, data } = state;

    // ВЕТКА ШТУЧНЫЙ ТОВАР
    if (step === 'FIXED_NAME') {
      data.name = text;
      pushWizardStep(userStates, userId, 'FIXED_DESC');
      return renderWizardStep(ctx, userStates, false);
    }

    if (step === 'FIXED_DESC') {
      data.description = text === '-' ? '' : text;
      pushWizardStep(userStates, userId, 'FIXED_CATEGORY');
      return renderWizardStep(ctx, userStates, false);
    }

    if (step === 'FIXED_PRICE') {
      const priceNum = parseMoney(text, 0);
      if (priceNum <= 0) {
        return ctx.reply('⚠️ Введите корректную цену больше нуля (например: <code>499.99</code> или <code>1,02</code>):', { parse_mode: 'HTML' });
      }
      data.price = priceNum;
      pushWizardStep(userStates, userId, 'FIXED_DELIVERY');
      return renderWizardStep(ctx, userStates, false);
    }

    if (step === 'FIXED_KEYS') {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) {
        return ctx.reply('⚠️ Отправьте хотя бы один ключ или строку данных.');
      }
      data.secret_data = lines.join('\n');
      data.stock = lines.length;
      data.is_unlimited = 0;
      pushWizardStep(userStates, userId, 'FIXED_CHECK');
      return renderWizardStep(ctx, userStates, false);
    }

    if (step === 'FIXED_STOCK') {
      const isInf = ['inf', 'бесконечно', 'infinity', 'inf.', '∞'].includes(text.toLowerCase());
      if (isInf) {
        data.is_unlimited = 1;
        data.stock = 999999;
      } else {
        const stockNum = parseInt(text, 10);
        if (isNaN(stockNum) || stockNum <= 0) {
          return ctx.reply('⚠️ Введите число > 0 или <code>inf</code>:', { parse_mode: 'HTML' });
        }
        data.is_unlimited = 0;
        data.stock = stockNum;
      }
      pushWizardStep(userStates, userId, 'FIXED_CHECK');
      return renderWizardStep(ctx, userStates, false);
    }

    // ВЕТКА ПОПОЛНЕНИЕ БАЛАНСА / ГИБКАЯ УСЛУГА
    if (step === 'FLEX_EMOJI') {
      data.emoji = text.trim() || '📦';
      pushWizardStep(userStates, userId, 'FLEX_NAME');
      return renderWizardStep(ctx, userStates, false);
    }

    if (step === 'FLEX_NAME') {
      data.name = text;
      pushWizardStep(userStates, userId, 'FLEX_CURRENCY');
      return renderWizardStep(ctx, userStates, false);
    }

    if (step === 'FLEX_CURRENCY') {
      data.currency_symbol = text.trim() || '₽';
      pushWizardStep(userStates, userId, 'FLEX_RATE');
      return renderWizardStep(ctx, userStates, false);
    }

    if (step === 'FLEX_RATE') {
      const parsedRate = parseMoney(text, 1.0);
      if (parsedRate <= 0) {
        return ctx.reply('⚠️ Введите корректный курс больше нуля (например: <code>0.20</code>, <code>1.95</code> или <code>92.5</code>):', { parse_mode: 'HTML' });
      }
      data.exchange_rate = parsedRate;
      pushWizardStep(userStates, userId, 'FLEX_DESC');
      return renderWizardStep(ctx, userStates, false);
    }

    if (step === 'FLEX_DESC') {
      data.description = text === '-' ? '' : text;
      pushWizardStep(userStates, userId, 'FLEX_CATEGORY');
      return renderWizardStep(ctx, userStates, false);
    }

    if (step === 'FLEX_RANGE') {
      // Поддержка ввода диапазона вида "50-50000" или "50 - 50000" или "50 50000"
      const parts = text.includes('-') ? text.split('-') : text.trim().split(/\s+/);
      if (parts.length >= 2) {
        const minNum = parseMoney(parts[0], 0);
        const maxNum = parseMoney(parts[1], 0);
        if (minNum > 0 && maxNum > 0 && maxNum >= minNum) {
          data.min_amount = minNum;
          data.max_amount = maxNum;
          pushWizardStep(userStates, userId, 'FLEX_FEE_TYPE');
          return renderWizardStep(ctx, userStates, false);
        }
      }
      return ctx.reply(
        '⚠️ Введите корректный диапазон через дефис (например: <code>50-50000</code> или <code>100 - 15000</code>), где максимум больше минимума:',
        { parse_mode: 'HTML' }
      );
    }

    if (step === 'FLEX_MIN') {
      const minNum = parseMoney(text, 0);
      if (minNum <= 0) {
        return ctx.reply('⚠️ Введите положительную сумму (например: <code>100</code> или <code>50.50</code>):', { parse_mode: 'HTML' });
      }
      data.min_amount = minNum;
      pushWizardStep(userStates, userId, 'FLEX_MAX');
      return renderWizardStep(ctx, userStates, false);
    }

    if (step === 'FLEX_MAX') {
      const maxNum = parseMoney(text, 0);
      if (maxNum <= 0 || maxNum < data.min_amount) {
        return ctx.reply(`⚠️ Максимальная сумма должна быть больше минимальной (${formatMoney(data.min_amount)}). Повторите ввод:`, { parse_mode: 'HTML' });
      }
      data.max_amount = maxNum;
      pushWizardStep(userStates, userId, 'FLEX_FEE_TYPE');
      return renderWizardStep(ctx, userStates, false);
    }

    if (step === 'FLEX_FEE_VALUE') {
      const rawInput = text.replace(',', '.').trim();
      const parsedFee = parseFloat(rawInput);
      const feeNum = (!isNaN(parsedFee) && parsedFee >= 0) ? parsedFee : 0;
      data.fee_value = feeNum;
      data.fee_percent = data.fee_type === 'PERCENT' ? feeNum : 0;
      data.fee_fixed = data.fee_type === 'FIXED' ? feeNum : 0;
      pushWizardStep(userStates, userId, 'FLEX_DECIMALS');
      return renderWizardStep(ctx, userStates, false);
    }
  }

  // 5. Админ ищет заказ по номеру
  if (state?.type === 'ADMIN_SEARCH_ORDER_ID' && isAdmin(userId)) {
    userStates.delete(userId);
    const orderId = parseInt(text.replace(/\D/g, ''), 10);
    if (!orderId) {
      return ctx.reply('⚠️ Введите корректный номер заказа (например: 10):');
    }

    const order = db.getOrderById(orderId);
    if (!order) {
      return ctx.reply(`❌ Заказ #${orderId} не найден в базе данных.`, Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Повторить поиск', 'admin_search_order')],
        [Markup.button.callback('◀️ К заказам', 'admin_orders_menu')],
      ]));
    }

    ctx.match = [, String(orderId)];
    return bot.handleUpdate(ctx.update);
  }

  // 6. Админ отправляет данные покупателю вручную (MANUAL)
  if (state?.type === 'ADMIN_AWAITING_MANUAL_SEND' && isAdmin(userId)) {
    const orderId = state.orderId;
    const order = db.getOrderById(orderId);
    userStates.delete(userId);

    if (!order) return ctx.reply('❌ Заказ не найден.');

    db.approveOrder(orderId, text, text);

    try {
      await safeSendMessage(
        ctx.telegram,
        order.user_id,
        `🔑 <b>ДАННЫЕ ПО ВАШЕМУ ЗАКАЗУ #${order.id}</b>\n\n` +
        `📦 <b>Лот:</b> ${escapeHtml(order.product_name)}\n\n` +
        `<pre>${escapeHtml(text)}</pre>\n\n` +
        `<i>Данные также сохранены в разделе «🛍 Мои покупки».</i>\n` +
        `Благодарим за покупку! При вопросах: ${escapeHtml(SUPPORT_CONTACT)}`
      );

      await ctx.reply(`✅ Сообщение с данными успешно отправлено покупателю (ID: ${order.user_id})!`);
    } catch (sendErr) {
      await ctx.reply(`⚠️ Не удалось доставить сообщение покупателю: ${sendErr.message}`);
    }
    return;
  }

  // 7. Админ отклоняет заказ с причиной
  if (state?.type === 'ADMIN_AWAITING_REJECT_REASON' && isAdmin(userId)) {
    const orderId = state.orderId;
    const order = db.getOrderById(orderId);
    userStates.delete(userId);

    if (!order) return ctx.reply('❌ Заказ не найден.');

    db.rejectOrder(orderId, text);

    try {
      await safeSendMessage(
        ctx.telegram,
        order.user_id,
        `❌ <b>Ваш заказ #${order.id} был отклонен.</b>\n\n` +
        `📦 Товар: ${escapeHtml(order.product_name)} (${formatMoney(order.amount)})\n` +
        `⚠️ <b>Причина отказа:</b> <i>${escapeHtml(text)}</i>\n\n` +
        `Бронь товара снята. При вопросах: ${escapeHtml(SUPPORT_CONTACT)}`
      );
    } catch (e) {}

    await ctx.reply(`❌ Заказ #${orderId} отклонен с причиной: «${text}». Бронь товара снята.`);
    return;
  }

  // 8. Админ меняет название товара
  if (state?.type === 'ADMIN_EDIT_NAME' && isAdmin(userId)) {
    const productId = state.productId;
    userStates.delete(userId);

    const updated = db.updateProductName(productId, text);
    await ctx.reply(`✅ Название лота #${updated.id} изменено на: <b>${escapeHtml(updated.name)}</b>`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 К лоту', `admin_manage_prod_${updated.id}`)],
        [Markup.button.callback('📋 К списку лотов', 'admin_products_list')],
      ]),
    });
    return;
  }

  // 9. Админ меняет описание товара
  if (state?.type === 'ADMIN_EDIT_DESC' && isAdmin(userId)) {
    const productId = state.productId;
    userStates.delete(userId);

    const newDesc = text === '-' ? '' : text;
    const updated = db.updateProductDescription(productId, newDesc);
    await ctx.reply(`✅ Описание лота #${updated.id} успешно обновлено!`, {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 К лоту', `admin_manage_prod_${updated.id}`)],
        [Markup.button.callback('📋 К списку лотов', 'admin_products_list')],
      ]),
    });
    return;
  }

  // 9.1. Админ меняет эмодзи товара
  if (state?.type === 'ADMIN_EDIT_EMOJI' && isAdmin(userId)) {
    const productId = state.productId;
    userStates.delete(userId);
    const updated = db.updateProductEmoji(productId, text.trim() || '📦');
    await ctx.reply(`✅ Эмодзи лота #${updated.id} изменен на: <b>${updated.emoji}</b>`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 К лоту', `admin_manage_prod_${updated.id}`)],
        [Markup.button.callback('📋 К списку лотов', 'admin_products_list')],
      ]),
    });
    return;
  }

  // 9.2. Админ меняет валюту товара
  if (state?.type === 'ADMIN_EDIT_CURRENCY' && isAdmin(userId)) {
    const productId = state.productId;
    userStates.delete(userId);
    const updated = db.updateProductCurrency(productId, text.trim() || '₽');
    await ctx.reply(`✅ Валюта лота #${updated.id} изменена на: <b>${updated.currency_symbol}</b>`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 К лоту', `admin_manage_prod_${updated.id}`)],
        [Markup.button.callback('📋 К списку лотов', 'admin_products_list')],
      ]),
    });
    return;
  }

  // 9.3. Админ меняет курс валюты товара
  if (state?.type === 'ADMIN_EDIT_EXCHANGE_RATE' && isAdmin(userId)) {
    const parsedRate = parseMoney(text, 0);
    if (parsedRate <= 0) {
      return ctx.reply('⚠️ Введите корректный курс больше нуля (например: <code>0.20</code>, <code>1.95</code> или <code>92.5</code>):', { parse_mode: 'HTML' });
    }
    const productId = state.productId;
    userStates.delete(userId);
    const updated = db.updateProductExchangeRate(productId, parsedRate);
    await ctx.reply(`✅ Курс валюты лота #${updated.id} изменен: <b>1 ${updated.currency_symbol} = ${updated.exchange_rate} ₽</b>!`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 К лоту', `admin_manage_prod_${updated.id}`)],
        [Markup.button.callback('📋 К списку лотов', 'admin_products_list')],
      ]),
    });
    return;
  }

  // 10. Админ редактирует цену товара
  if (state?.type === 'ADMIN_EDIT_PRICE' && isAdmin(userId)) {
    const newPrice = parseMoney(text, 0);
    if (newPrice <= 0) {
      return ctx.reply('⚠️ Введите корректную цену (например: <code>499.99</code> или <code>1,02</code>):', { parse_mode: 'HTML' });
    }

    const productId = state.productId;
    userStates.delete(userId);

    const updated = db.updateProductPrice(productId, newPrice);
    await ctx.reply(`✅ Цена для лота <b>#${updated.id}</b> изменена на <b>${formatMoney(updated.price)}</b>!`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 К лоту', `admin_manage_prod_${updated.id}`)],
        [Markup.button.callback('📋 К списку лотов', 'admin_products_list')],
      ]),
    });
    return;
  }

  // 11. Админ редактирует мин. сумму (FLEXIBLE)
  if (state?.type === 'ADMIN_EDIT_MIN_AMOUNT' && isAdmin(userId)) {
    const minAmount = parseMoney(text, 0);
    if (minAmount <= 0) {
      return ctx.reply('⚠️ Введите положительную сумму больше нуля:', { parse_mode: 'HTML' });
    }

    const productId = state.productId;
    userStates.delete(userId);

    const updated = db.updateProductMinAmount(productId, minAmount);
    await ctx.reply(`✅ Минимальная сумма для лота <b>#${updated.id}</b> изменена на <b>${formatMoney(updated.min_amount)}</b>!`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 К лоту', `admin_manage_prod_${updated.id}`)],
        [Markup.button.callback('📋 К списку лотов', 'admin_products_list')],
      ]),
    });
    return;
  }

  // 12. Админ редактирует макс. сумму (FLEXIBLE)
  if (state?.type === 'ADMIN_EDIT_MAX_AMOUNT' && isAdmin(userId)) {
    const maxAmount = parseMoney(text, 0);
    const productId = state.productId;
    const currentProd = db.getProductById(productId);

    if (maxAmount <= 0 || (currentProd && maxAmount < currentProd.min_amount)) {
      return ctx.reply(`⚠️ Максимальная сумма должна быть больше минимальной (${formatMoney(currentProd?.min_amount || 0)}):`, { parse_mode: 'HTML' });
    }

    userStates.delete(userId);
    const updated = db.updateProductMaxAmount(productId, maxAmount);
    await ctx.reply(`✅ Максимальная сумма для лота <b>#${updated.id}</b> изменена на <b>${formatMoney(updated.max_amount)}</b>!`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 К лоту', `admin_manage_prod_${updated.id}`)],
        [Markup.button.callback('📋 К списку лотов', 'admin_products_list')],
      ]),
    });
    return;
  }

  // 13. Админ редактирует комиссию (FLEXIBLE)
  if ((state?.type === 'ADMIN_EDIT_FEE_VALUE' || state?.type === 'ADMIN_EDIT_FEE_PERCENT') && isAdmin(userId)) {
    const rawInput = text.replace(',', '.').trim();
    const parsedFee = parseFloat(rawInput);
    const feeValue = (!isNaN(parsedFee) && parsedFee >= 0) ? parsedFee : 0;
    const productId = state.productId;
    const feeType = state.feeType || 'PERCENT';
    userStates.delete(userId);

    const updated = db.updateProductFee(productId, feeType, feeValue);
    await ctx.reply(`✅ Комиссия/наценка для лота <b>#${updated.id}</b> изменена на <b>${formatFeeLabel(updated)}</b>!`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 К лоту', `admin_manage_prod_${updated.id}`)],
        [Markup.button.callback('📋 К списку лотов', 'admin_products_list')],
      ]),
    });
    return;
  }

  // 14. Админ пополняет ключи для AUTO-товара
  if (state?.type === 'ADMIN_REPLENISH_AUTO_KEYS' && isAdmin(userId)) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      return ctx.reply('⚠️ Отправьте хотя бы один ключ или строку данных.');
    }

    const productId = state.productId;
    userStates.delete(userId);

    const updated = db.replenishProductStock(productId, { additionalKeys: text });
    await ctx.reply(
      `🎉 <b>Успешно добавлено ${lines.length} ключей!</b>\n\n` +
      `Лот: <b>#${updated.id} ${escapeHtml(updated.name)}</b>\n` +
      `Новый остаток на складе: <b>${updated.stock} шт.</b>\n` +
      `Товар снова доступен в каталоге!`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📦 К лоту', `admin_manage_prod_${updated.id}`)],
          [Markup.button.callback('📋 К списку лотов', 'admin_products_list')],
        ]),
      }
    );
    return;
  }

  // 15. Админ пополняет наличие для MANUAL-товара
  if (state?.type === 'ADMIN_REPLENISH_MANUAL_STOCK' && isAdmin(userId)) {
    const isInf = ['inf', 'бесконечно', 'infinity', 'inf.', '∞'].includes(text.toLowerCase());
    const productId = state.productId;
    userStates.delete(userId);

    let updated;
    if (isInf) {
      updated = db.replenishProductStock(productId, { setUnlimited: true });
    } else {
      const added = parseInt(text, 10);
      if (isNaN(added) || added <= 0) {
        return ctx.reply('⚠️ Введите положительное число или <code>inf</code>:');
      }
      updated = db.replenishProductStock(productId, { addStock: added });
    }

    const stockStr = updated.is_unlimited ? 'Бесконечно (∞)' : `${updated.stock} шт.`;

    await ctx.reply(
      `🎉 <b>Наличие лота обновлено!</b>\n\n` +
      `Лот: <b>#${updated.id} ${escapeHtml(updated.name)}</b>\n` +
      `Текущее наличие: <b>${stockStr}</b>\n` +
      `Товар доступен покупателям!`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📦 К лоту', `admin_manage_prod_${updated.id}`)],
          [Markup.button.callback('📋 К списку лотов', 'admin_products_list')],
        ]),
      }
    );
    return;
  }

  // 17. Админ вводит ID пользователя для сброса активных заказов
  if (state?.type === 'ADMIN_AWAITING_RESET_USER_ID' && isAdmin(userId)) {
    userStates.delete(userId);
    const targetUserId = Number(text.replace(/\D/g, ''));
    if (!targetUserId) {
      return ctx.reply('⚠️ Введите корректный числовой Telegram ID пользователя (например: <code>123456789</code>):', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_panel')]]),
      });
    }

    const cancelledCount = db.resetUserPendingOrders(targetUserId);
    userStates.delete(targetUserId);

    await safeSendMessage(
      ctx.telegram,
      targetUserId,
      `ℹ️ <b>Ваши активные заказы были сброшены администратором.</b>\nТеперь вы можете оформить новый заказ в каталоге.`,
      getMainMenuKeyboard(targetUserId)
    );

    return ctx.reply(
      `✅ <b>Успешно сброшено активных заказов: ${cancelledCount}</b> для пользователя <code>${targetUserId}</code>.\n\nПользователь теперь может беспрепятственно оформлять новые заказы.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🛑 Сбросить еще', 'admin_reset_user_order')],
          [Markup.button.callback('◀️ В админ-панель', 'admin_panel')],
        ]),
      }
    );
  }

  // 18. Покупатель вводит промокод для скидки
  if (state?.type === 'AWAITING_PROMOCODE') {
    const draft = ctx.session?.draftOrder || state?.draftOrder;
    if (!draft) {
      userStates.delete(userId);
      return ctx.reply('❌ Черновик заказа не найден. Выберите товар в каталоге:', getMainMenuKeyboard(userId));
    }

    const code = text.trim();
    const originalAmount = draft.originalTotalPrice || draft.totalPrice || draft.amount;
    const productId = draft.productId;

    const validation = db.validatePromocode(code, userId, originalAmount, productId);

    if (!validation.valid) {
      return ctx.reply(
        `❌ <b>Не удалось применить промокод:</b>\n${escapeHtml(validation.message)}\n\nПопробуйте ввести другой промокод или нажмите отмену:`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('❌ Отмена', 'cancel_promocode_input')],
          ]),
        }
      );
    }

    // Применяем промокод к черновику заказа
    draft.originalTotalPrice = originalAmount;
    draft.promoId = validation.promo.id;
    draft.promoCode = validation.promo.code;
    draft.discountAmount = validation.discountAmount;
    draft.totalPrice = validation.finalAmount;
    draft.amount = validation.finalAmount;

    if (ctx.session) {
      ctx.session.draftOrder = draft;
      ctx.session.step = 'AWAITING_RECEIPT';
    }

    userStates.set(userId, {
      type: 'AWAITING_RECEIPT',
      draftOrder: draft,
    });

    await ctx.reply(
      `🎉 <b>Промокод «${escapeHtml(validation.promo.code)}» успешно применен!</b>\n\n` +
      `• Скидка: <b>-${formatMoney(validation.discountAmount)}</b>\n` +
      `• Новая сумма к оплате: <b>${formatMoney(validation.finalAmount)}</b>`,
      { parse_mode: 'HTML' }
    );

    return sendDraftPaymentInstructions(ctx, draft);
  }

  // 19. Мастер создания промокода администратором (WIZARD)
  if (state?.type === 'ADMIN_PROMO_WIZARD' && isAdmin(userId)) {
    const { step, data } = state;

    if (step === 'CODE') {
      const cleanCode = text.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (!cleanCode || cleanCode.length < 2) {
        return ctx.reply('⚠️ Промокод должен содержать минимум 2 символа (буквы, цифры). Введите заново:');
      }

      const existing = db.getPromocodeByCode(cleanCode);
      if (existing) {
        return ctx.reply(
          `⚠️ Промокод <code>${escapeHtml(cleanCode)}</code> уже существует в базе! Введите другое кодовое слово:`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_promo_cancel')]]),
          }
        );
      }

      data.code = cleanCode;
      state.step = 'DISCOUNT_TYPE';

      const promptText =
        `🎟 <b>Создание промокода (Шаг 2 из 6)</b>\n\n` +
        `Код: <b>${cleanCode}</b>\n\n` +
        `Выберите тип скидки:`;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('💵 Фиксированная сумма (₽)', 'admin_promo_type_FIXED'),
          Markup.button.callback('📊 Процент (%)', 'admin_promo_type_PERCENT'),
        ],
        [Markup.button.callback('❌ Отмена', 'admin_promo_cancel')],
      ]);

      return ctx.reply(promptText, { parse_mode: 'HTML', ...keyboard });
    }

    if (step === 'DISCOUNT_VALUE') {
      const val = parseMoney(text, 0);
      if (val <= 0) {
        return ctx.reply('⚠️ Размер скидки должен быть больше 0. Попробуйте еще раз:');
      }
      if (data.discount_type === 'PERCENT' && (val < 1 || val > 99)) {
        return ctx.reply('⚠️ Процентная скидка должна быть в диапазоне от 1% до 99%. Попробуйте еще раз:');
      }

      data.discount_value = val;
      state.step = 'TARGET_TYPE';

      const promptText =
        `🎟 <b>Создание промокода (Шаг 4 из 6)</b>\n\n` +
        `Код: <b>${data.code}</b>\n` +
        `Скидка: <b>${data.discount_type === 'FIXED' ? `${formatMoney(val)}` : `${val}%`}</b>\n\n` +
        `Где действует данный промокод?`;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🌐 На все товары', 'admin_promo_target_ALL'),
          Markup.button.callback('🎯 На конкретный товар', 'admin_promo_target_SPECIFIC'),
        ],
        [Markup.button.callback('❌ Отмена', 'admin_promo_cancel')],
      ]);

      return ctx.reply(promptText, { parse_mode: 'HTML', ...keyboard });
    }

    if (step === 'MAX_USES') {
      const maxUses = parseInt(text.trim(), 10);
      if (isNaN(maxUses) || maxUses < 0) {
        return ctx.reply('⚠️ Введите целое число >= 0 (где 0 — бесконечно):');
      }

      data.max_uses = maxUses;
      state.step = 'MIN_ORDER_AMOUNT';

      const promptText =
        `🎟 <b>Создание промокода (Шаг 6 из 6)</b>\n\n` +
        `Укажите минимальную сумму заказа для применения промокода.\n` +
        `Введите сумму в рублях (например: <code>500</code>) или <b>0</b>, если ограничений нет:`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', 'admin_promo_cancel')],
      ]);

      return ctx.reply(promptText, { parse_mode: 'HTML', ...keyboard });
    }

    if (step === 'MIN_ORDER_AMOUNT') {
      const minAmount = parseMoney(text, -1);
      if (minAmount < 0) {
        return ctx.reply('⚠️ Введите корректную сумму >= 0:');
      }

      data.min_order_amount = minAmount;
      const promo = db.createPromocode(data);
      userStates.delete(userId);

      let targetLabel = '🌐 На все товары';
      if (promo.target_type === 'SPECIFIC' && promo.target_product_id) {
        const prod = db.getProductById(promo.target_product_id);
        targetLabel = prod ? `🎯 Только на «${prod.name}»` : '🎯 На выбранный товар';
      }

      const successMsg =
        `🎉 <b>Промокод «${escapeHtml(promo.code)}» успешно создан!</b>\n\n` +
        `• Скидка: <b>${promo.discount_type === 'FIXED' ? `${formatMoney(promo.discount_value)}` : `${promo.discount_value}%`}</b>\n` +
        `• Где действует: <b>${escapeHtml(targetLabel)}</b>\n` +
        `• Лимит активаций: <b>${promo.max_uses > 0 ? `${promo.max_uses} шт.` : 'Бесконечно (∞)'}</b>\n` +
        `• Мин. сумма заказа: <b>${promo.min_order_amount > 0 ? `${formatMoney(promo.min_order_amount)}` : 'Без ограничений'}</b>\n` +
        `• Статус: <b>🟢 Активен</b>\n\n` +
        `Покупатели могут активировать его при оформлении заказа!`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📋 Список промокодов', 'admin_promo_list')],
        [Markup.button.callback('➕ Создать еще промокод', 'admin_promo_create')],
        [Markup.button.callback('◀️ В админ-панель', 'admin_panel')],
      ]);

      return ctx.reply(successMsg, { parse_mode: 'HTML', ...keyboard });
    }
  }

    // Обычное сообщение
    await ctx.reply('Используйте меню для навигации по магазину 👇', getMainMenuKeyboard(userId));
  } catch (err) {
    console.error(`[bot.on('text') ERROR for user ${userId}]:`, err);
    try {
      await ctx.reply('⚠️ Произошла непредвиденная ошибка при обработке ввода. Состояние сброшено. Введите /start или выберите действие в меню:', getMainMenuKeyboard(userId));
    } catch (sendErr) {
      // ignore
    }
  }
});

// ==========================================
// ОБРАБОТКА ОШИБОК И ЗАПУСК
// ==========================================

// Глобальный перехват ошибок Telegraf (Crash Protection & Anti-Spam Loop)
bot.catch(async (err, ctx) => {
  const errMsg = err?.message || err?.description || String(err);
  console.error('[Bot Error]', err);

  // Игнорируем таймауты, сетевые дропы, лимиты запросов и устаревшие callback'и, чтобы не спамить
  if (
    errMsg.includes('Timed out') ||
    errMsg.includes('timed out') ||
    errMsg.includes('timeout') ||
    errMsg.includes('TimeoutError') ||
    errMsg.includes('429') ||
    errMsg.includes('Too Many Requests') ||
    errMsg.includes('query is too old') ||
    errMsg.includes('response timeout expired') ||
    errMsg.includes('query ID is invalid') ||
    errMsg.includes('message is not modified')
  ) {
    return;
  }

  // 1. Мягкое уведомление пользователю (безопасно, без риска повторного падения)
  try {
    const userChatId = ctx?.chat?.id || ctx?.from?.id;
    if (userChatId) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('⚠️ Произошла временная ошибка, попробуйте еще раз', { show_alert: true }).catch(() => {});
      }
      await safeSendMessage(
        ctx.telegram,
        userChatId,
        `⚠️ <b>Произошла временная ошибка, попробуйте еще раз.</b>\nЕсли проблема повторяется, обратитесь в поддержку: ${escapeHtml(SUPPORT_CONTACT)}`,
        getMainMenuKeyboard(userChatId)
      ).catch(() => {});
    }
  } catch (userNoticeErr) {
    // глушим
  }

  // 2. Безопасная отправка админу без риска рекурсии и спама
  try {
    const adminIds = getAdminIds();
    const shortErrMsg = errMsg.slice(0, 300);
    const alertMsg = `⚠️ Ошибка: ${escapeHtml(shortErrMsg)}`;

    for (const aId of adminIds) {
      bot.telegram.sendMessage(aId, alertMsg, { parse_mode: 'HTML' }).catch(() => {});
    }
  } catch (adminAlertErr) {
    // глушим
  }
});

// Глобальная защита процесса от падения (Node.js Process Protections)
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.warn('[PROCESS WARNING] Порт уже занят (EADDRINUSE). Работа продолжается.');
    return;
  }
  console.error('[CRITICAL PROCESS ERROR] uncaughtException (перехвачено):', err);
  try {
    const adminIds = getAdminIds();
    const token = BOT_TOKEN;
    if (token && token !== 'DUMMY_TOKEN_NOT_CONFIGURED' && adminIds.length > 0) {
      const stackSnippet = (err?.stack || String(err)).slice(0, 3000);
      const crashAlert =
        `💥 <b>КРИТИЧЕСКИЙ СБОЙ ПРОЦЕССА (uncaughtException)!</b>\n\n` +
        `<b>Ошибка:</b> <code>${escapeHtml(err?.message || 'Unknown')}</code>\n\n` +
        `<pre>${escapeHtml(stackSnippet)}</pre>`;

      for (const aId of adminIds) {
        safeSendMessage(bot.telegram, aId, crashAlert).catch(() => {});
      }
    }
  } catch (e) {}
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL PROCESS PROMISE] unhandledRejection (перехвачено):', reason);
  try {
    const adminIds = getAdminIds();
    const token = BOT_TOKEN;
    if (token && token !== 'DUMMY_TOKEN_NOT_CONFIGURED' && adminIds.length > 0) {
      const reasonMsg = reason?.message || String(reason) || 'Unknown reason';
      const stackSnippet = (reason?.stack || String(reason)).slice(0, 3000);
      const rejAlert =
        `⚠️ <b>НЕОБРАБОТАННЫЙ ПРОМИС (unhandledRejection)!</b>\n\n` +
        `<b>Причина:</b> <code>${escapeHtml(reasonMsg)}</code>\n\n` +
        `<pre>${escapeHtml(stackSnippet)}</pre>`;

      for (const aId of adminIds) {
        safeSendMessage(bot.telegram, aId, rejAlert).catch(() => {});
      }
    }
  } catch (e) {}
});

let isBotLaunching = false;

// 3. Плавная остановка (Graceful Shutdown)
process.once('SIGINT', () => {
  if (healthServer) {
    try { healthServer.close(); } catch (e) {}
  }
  try { bot.stop('SIGINT'); } catch (e) {}
});

process.once('SIGTERM', () => {
  if (healthServer) {
    try { healthServer.close(); } catch (e) {}
  }
  try { bot.stop('SIGTERM'); } catch (e) {}
});

// 2. БЕСКОНЕЧНЫЙ ЦИКЛ ПОДКЛЮЧЕНИЯ LONG-POLLING:
async function launchBot() {
  if (isBotLaunching) return;
  isBotLaunching = true;

  if (!BOT_TOKEN || BOT_TOKEN === 'DUMMY_TOKEN_NOT_CONFIGURED') {
    console.log('[BOT INFO] Telegram-бот не запущен (укажите BOT_TOKEN в .env)');
    isBotLaunching = false;
    return;
  }

  try {
    console.log('🔄 Подключение к Telegram API...');
    await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    await bot.launch();
    console.log('✅ Telegram Bot успешно подключен к Polling');
  } catch (err) {
    console.error('⚠️ Ошибка подключения bot.launch. Перезапуск через 10 секунд...', err.message);
    isBotLaunching = false;
    setTimeout(launchBot, 10000);
  }
}

launchBot();

export const initApp = launchBot;
export const startBot = launchBot;
export const startBotLoop = launchBot;
export default bot;
