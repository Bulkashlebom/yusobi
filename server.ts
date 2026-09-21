/**
 * server.ts - Express сервер для веб-панели управления магазином и симулятора Telegram-бота.
 * Работает исключительно с локальной базой данных SQLite (better-sqlite3) без внешних API.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import db, { formatMoney, parseMoney } from './db.js';
import { bot, startBot, userStates, safeSendMessage, escapeHtml } from './bot.js';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// =================================================================
// 1. ВНУТРЕННИЙ REST API ДЛЯ ВЕБ-ПАНЕЛИ УПРАВЛЕНИЯ
// =================================================================

// Статус системы и базы данных
app.get('/api/system/status', (req, res) => {
  const stats = db.getDatabaseStats();

  res.json({
    bot: {
      hasToken: Boolean(process.env.BOT_TOKEN && process.env.BOT_TOKEN !== 'DUMMY_TOKEN_NOT_CONFIGURED'),
      tokenMasked: process.env.BOT_TOKEN
        ? `${process.env.BOT_TOKEN.slice(0, 6)}...${process.env.BOT_TOKEN.slice(-4)}`
        : 'не установлен',
      adminId: process.env.ADMIN_ID || 'не указан',
      paymentDetails: process.env.PAYMENT_DETAILS || 'не указаны',
      supportContact: process.env.SUPPORT_CONTACT || '@l_dont_understand',
    },
    database: stats,
  });
});

// Получение списка всех заказов
app.get('/api/orders', (req, res) => {
  const orders = db.getAllOrders();
  res.json({ orders });
});

// Получение списка всех товаров
app.get('/api/custom-products', (req, res) => {
  const products = db.getAllProducts();
  res.json({ products });
});

// Добавление товара через веб-панель
app.post('/api/custom-products', (req, res) => {
  const {
    name,
    description,
    price,
    delivery_type,
    secret_data,
    stock,
    is_unlimited,
    product_type,
    min_amount,
    max_amount,
    fee_percent,
    fee_fixed,
  } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Поле "Название" обязательно для заполнения' });
  }

  const isFlexible = product_type === 'FLEXIBLE';

  if (!isFlexible && (!price || Number(price) <= 0)) {
    return res.status(400).json({ error: 'Поле "Цена" обязательно для штучного товара' });
  }

  const deliveryType = isFlexible ? 'MANUAL' : delivery_type === 'MANUAL' ? 'MANUAL' : 'AUTO';
  if (!isFlexible && deliveryType === 'AUTO' && !secret_data) {
    return res.status(400).json({ error: 'Для автовыдачи необходимо указать данные/ключи' });
  }

  const product = db.createProduct({
    name,
    description: description || '',
    price: Number(price || 0),
    delivery_type: deliveryType,
    secret_data: deliveryType === 'AUTO' ? secret_data : null,
    stock: isFlexible ? 999999 : stock,
    is_unlimited: isFlexible ? 1 : is_unlimited ? 1 : 0,
    product_type: isFlexible ? 'FLEXIBLE' : 'FIXED',
    min_amount: Number(min_amount || 0),
    max_amount: Number(max_amount || 0),
    fee_percent: Number(fee_percent || 0),
    fee_fixed: Number(fee_fixed || 0),
  });

  res.json({ success: true, product });
});

// Изменение названия товара
app.patch('/api/custom-products/:id/name', (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Название не может быть пустым' });
  }
  const product = db.updateProductName(id, String(name).trim());
  res.json({ success: true, product });
});

// Изменение описания товара
app.patch('/api/custom-products/:id/description', (req, res) => {
  const id = Number(req.params.id);
  const { description } = req.body;
  const product = db.updateProductDescription(id, description || '');
  res.json({ success: true, product });
});

// Изменение цены товара
app.patch('/api/custom-products/:id/price', (req, res) => {
  const id = Number(req.params.id);
  const { price } = req.body;
  if (price === undefined || Number(price) <= 0) {
    return res.status(400).json({ error: 'Укажите корректную положительную цену' });
  }
  const product = db.updateProductPrice(id, Number(price));
  res.json({ success: true, product });
});

// Изменение мин. суммы пополнения (FLEXIBLE)
app.patch('/api/custom-products/:id/min-amount', (req, res) => {
  const id = Number(req.params.id);
  const { min_amount } = req.body;
  if (min_amount === undefined || Number(min_amount) < 0) {
    return res.status(400).json({ error: 'Укажите корректную минимальную сумму' });
  }
  const product = db.updateProductMinAmount(id, Number(min_amount));
  res.json({ success: true, product });
});

// Изменение макс. суммы пополнения (FLEXIBLE)
app.patch('/api/custom-products/:id/max-amount', (req, res) => {
  const id = Number(req.params.id);
  const { max_amount } = req.body;
  if (max_amount === undefined || Number(max_amount) <= 0) {
    return res.status(400).json({ error: 'Укажите корректную максимальную сумму' });
  }
  const product = db.updateProductMaxAmount(id, Number(max_amount));
  res.json({ success: true, product });
});

// Изменение комиссии (FLEXIBLE)
app.patch('/api/custom-products/:id/fee-percent', (req, res) => {
  const id = Number(req.params.id);
  const { fee_percent } = req.body;
  if (fee_percent === undefined || Number(fee_percent) < 0) {
    return res.status(400).json({ error: 'Укажите корректный процент комиссии' });
  }
  const product = db.updateProductFee(id, Number(fee_percent));
  res.json({ success: true, product });
});

// Переключение типа доставки (AUTO <-> MANUAL) в 1 клик
app.post('/api/custom-products/:id/toggle-type', (req, res) => {
  const id = Number(req.params.id);
  const product = db.toggleProductDeliveryType(id);
  if (!product) {
    return res.status(404).json({ error: 'Товар не найден' });
  }
  res.json({ success: true, product });
});

// Переключение видимости (Скрыть / Показать на витрине) в 1 клик
app.post('/api/custom-products/:id/toggle-visibility', (req, res) => {
  const id = Number(req.params.id);
  const product = db.toggleProductVisibility(id);
  if (!product) {
    return res.status(404).json({ error: 'Товар не найден' });
  }
  res.json({ success: true, product });
});

// Пополнение наличия (stock / ключей)
app.post('/api/custom-products/:id/replenish', (req, res) => {
  const id = Number(req.params.id);
  const { additionalKeys, addStock, setUnlimited } = req.body;
  const product = db.replenishProductStock(id, { additionalKeys, addStock, setUnlimited });
  if (!product) {
    return res.status(404).json({ error: 'Товар не найден' });
  }
  res.json({ success: true, product });
});

// Удаление товара
app.delete('/api/custom-products/:id', (req, res) => {
  const id = Number(req.params.id);
  const success = db.deleteProduct(id);
  res.json({ success });
});

// Ручное подтверждение заказа из веб-панели (с выдачей qty ключей и освобождением брони)
app.post('/api/admin/orders/:id/approve', async (req, res) => {
  const orderId = Number(req.params.id);
  const { comment } = req.body;
  const order = db.getOrderById(orderId) as any;

  if (!order) {
    return res.status(404).json({ error: 'Заказ не найден' });
  }

  try {
    // Списание товара из остатка и отрезание qty верхних ключей для AUTO
    const deliveryResult = db.processProductDeliveryOnApproval(order.id);

    // Подтверждаем заказ и сохраняем выданные ключи
    const updated = db.approveOrder(order.id, comment || null, deliveryResult.givenKeys || null);

    // Если бот активен и настроен, отправляем уведомление покупателю в Telegram
    if (process.env.BOT_TOKEN && order.user_id && order.user_id !== 999999999) {
      try {
        const qty = order.quantity || 1;
        if (order.product_delivery_type === 'AUTO') {
          const keyText = deliveryResult.givenKeys || order.product_secret_data || 'Данные выданы администратором';
          await bot.telegram.sendMessage(
            order.user_id,
            `🎉 <b>Ваш заказ #${order.id} подтвержден!</b>\n\n` +
            `📦 <b>Товар:</b> ${order.product_name} (${qty} шт.)\n` +
            `🔑 <b>Данные/ключи:</b>\n<pre>${escapeHtml(keyText)}</pre>`,
            { parse_mode: 'HTML' }
          );
        } else {
          await bot.telegram.sendMessage(
            order.user_id,
            `🎉 <b>Оплата подтверждена!</b>\n\n` +
            `Продавец свяжется с вами или отправит товар в ближайшее время.\n` +
            `📦 Товар: ${order.product_name} (${qty} шт.)\n` +
            `🧾 Заказ: #${order.id}`,
            { parse_mode: 'HTML' }
          );
        }
      } catch (err: any) {
        console.warn('Telegram send notice error:', err.message);
      }
    }

    res.json({ success: true, order: updated, deliveryResult });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Ручное отклонение заказа из веб-панели (со снятием брони)
app.post('/api/admin/orders/:id/reject', async (req, res) => {
  const orderId = Number(req.params.id);
  const { reason } = req.body;
  const order = db.getOrderById(orderId) as any;

  if (!order) {
    return res.status(404).json({ error: 'Заказ не найден' });
  }

  const updated = db.rejectOrder(order.id, reason || 'Оплата не подтверждена');

  // Уведомление покупателя в Telegram
  if (process.env.BOT_TOKEN && order.user_id && order.user_id !== 999999999) {
    try {
      await bot.telegram.sendMessage(
        order.user_id,
        `❌ <b>Ваш заказ #${order.id} был отклонен.</b>\n\n` +
        `📦 Товар: ${order.product_name} (${order.quantity || 1} шт.)\n` +
        `⚠️ Причина: <i>${escapeHtml(reason || 'Оплата не подтверждена')}</i>\n\n` +
        `Бронь товара снята.`,
        { parse_mode: 'HTML' }
      );
    } catch (err: any) {
      console.warn('Telegram reject error:', err.message);
    }
  }

  res.json({ success: true, order: updated });
});

// Оформление возврата (REFUND) из веб-панели
app.post('/api/admin/orders/:id/refund', async (req, res) => {
  const orderId = Number(req.params.id);
  const { restock } = req.body;
  const order = db.getOrderById(orderId) as any;

  if (!order) {
    return res.status(404).json({ error: 'Заказ не найден' });
  }

  try {
    const updated = db.refundOrder(orderId, { restock: Boolean(restock) });

    // Уведомление покупателя
    if (process.env.BOT_TOKEN && order.user_id && order.user_id !== 999999999) {
      try {
        await bot.telegram.sendMessage(
          order.user_id,
          `🔔 <b>По вашему заказу #${order.id} оформлен возврат средств.</b>\n\n` +
          `📦 Товар: ${order.product_name} (${order.quantity || 1} шт.)\n` +
          `💰 Сумма к возврату: <b>${order.amount} ₽</b>\n\n` +
          `Свяжитесь с администратором: ${process.env.SUPPORT_CONTACT || '@l_dont_understand'}`,
          { parse_mode: 'HTML' }
        );
      } catch (err: any) {
        console.warn('Telegram refund notice error:', err.message);
      }
    }

    res.json({ success: true, order: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// =================================================================
// ЭНДПОИНТЫ БЕЗОПАСНОСТИ: ЧЕРНЫЙ СПИСОК И РЕЗЕРВНАЯ КОПИЯ
// =================================================================

// Получение списка заблокированных пользователей
app.get('/api/blacklist', (req, res) => {
  try {
    const list = db.getAllBlacklisted();
    res.json({ blacklist: list });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Добавление пользователя в черный список
app.post('/api/blacklist/add', (req, res) => {
  try {
    const { userId, reason } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId обязателен' });

    db.addToBlacklist(Number(userId), reason || 'Заблокирован через панель управления');
    res.json({ success: true, blacklist: db.getAllBlacklisted() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Удаление пользователя из черного списка
app.post('/api/blacklist/remove', (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId обязателен' });

    db.removeFromBlacklist(Number(userId));
    res.json({ success: true, blacklist: db.getAllBlacklisted() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Блокировка пользователя и отмена заказа (кнопка "В бан")
app.post('/api/admin/orders/:id/ban', async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const order = db.getOrderById(orderId) as any;
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });

    db.addToBlacklist(order.user_id, `Блокировка из заказа #${order.id} (попытка фрода / повторный чек)`);
    db.releaseProductReservation(order.id);
    const updated = db.cancelOrder(order.id, 'Пользователь заблокирован администратором');

    if (process.env.BOT_TOKEN && order.user_id && order.user_id !== 999999999) {
      try {
        await bot.telegram.sendMessage(
          order.user_id,
          `⛔ <b>Вы заблокированы в этом магазине.</b>\n\n` +
          `Заказ #${order.id} аннулирован. Доступ закрыт.\n` +
          `Связь с поддержкой: ${process.env.SUPPORT_CONTACT || '@l_dont_understand'}`,
          { parse_mode: 'HTML' }
        );
      } catch (e: any) {}
    }

    res.json({ success: true, order: updated, blacklist: db.getAllBlacklisted() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Скачивание резервной копии базы данных SQLite
app.get('/api/backup', (req, res) => {
  const dbPath = path.resolve(process.cwd(), 'shop.db');
  if (!fs.existsSync(dbPath)) {
    return res.status(404).json({ error: 'База данных shop.db не найдена' });
  }
  const dateStr = new Date().toISOString().slice(0, 10);
  res.download(dbPath, `shop_backup_${dateStr}.db`);
});

// Чтение файлов исходного кода для вкладки "Исходный код"
app.get('/api/files/:filename', (req, res) => {
  const allowed = ['bot.js', 'wizard.js', 'db.js', '.env.example', '.env', 'package.json'];
  const filename = req.params.filename;

  if (!allowed.includes(filename)) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  try {
    const filePath = path.resolve(process.cwd(), filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Файл не найден' });
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ filename, content });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// =================================================================
// 2. ВЕБ-СИМУЛЯТОР ДЛЯ ТЕСТИРОВАНИЯ БОТА В БРАУЗЕРЕ
// =================================================================

app.post('/api/bot/simulate', async (req, res) => {
  const { action, payload, userId = 999999999, username = 'tester' } = req.body;

  try {
    // 1. Проверка черного списка
    const banned = db.isBlacklisted(userId) as any;
    if (banned) {
      return res.json({
        type: 'text',
        text: `⛔ <b>Доступ заблокирован!</b>\n\nВы внесены в черный список магазина.\nПричина: <i>${escapeHtml(banned.reason || 'Нарушение правил')}</i>`,
        keyboard: [],
      });
    }

    // Автоматическая очистка истекших заказов (20 минут)
    db.cancelExpiredOrders(20);

    if (action === 'start') {
      userStates.delete(userId);
      const isAdm = true; // в веб-симуляторе даем доступ к админке
      return res.json({
        type: 'text',
        text: '👋 <b>Добро пожаловать в наш магазин цифровых товаров!</b>\n\nВыберите раздел в меню ниже 👇',
        keyboard: [
          [{ label: '📦 Каталог товаров', action: 'catalog' }],
          [{ label: '🛍 Мои покупки', action: 'my_orders' }, { label: '💬 Поддержка', action: 'support' }],
          ...(isAdm ? [[{ label: '👑 Панель администратора', action: 'admin' }]] : []),
        ],
      });
    }

    if (action === 'catalog') {
      const products = db.getAvailableProducts();
      return res.json({
        type: 'text',
        text: '📦 <b>Каталог товаров в наличии:</b>\nВыберите интересующий лот для просмотра:',
        products,
        keyboard: [
          ...products.map((p: any) => {
            const isFlex = p.product_type === 'FLEXIBLE';
            const icon = isFlex ? '💳' : p.delivery_type === 'MANUAL' ? '✍️' : '⚡';
            const priceLabel = isFlex ? `от ${formatMoney(p.min_amount)}` : formatMoney(p.price);
            return [
              {
                label: `${icon} ${p.name} — ${priceLabel}`,
                action: `view_prod_${p.id}_1`,
              },
            ];
          }),
          [{ label: '◀️ Главное меню', action: 'start' }],
        ],
      });
    }

    // Просмотр карточки товара с выбором количества: view_prod_ID_QTY
    if (action.startsWith('view_prod_')) {
      const parts = action.replace('view_prod_', '').split('_');
      const prodId = Number(parts[0]);
      let currentQty = Math.max(1, Number(parts[1]) || 1);

      const product = db.getProductById(prodId) as any;
      if (!product) {
        return res.json({
          type: 'text',
          text: '❌ Товар не найден или снят с продажи.',
          keyboard: [[{ label: '◀️ В каталог', action: 'catalog' }]],
        });
      }

      if (product.product_type === 'FLEXIBLE') {
        const feeText = product.fee_percent > 0 ? `+${product.fee_percent}%` : '0% (без наценки)';
        return res.json({
          type: 'product_card',
          product,
          text:
            `💳 <b>${product.name}</b>\n\n` +
            `📝 <b>Описание:</b> ${product.description || 'Услуга пополнения баланса'}\n\n` +
            `📊 <b>Допустимый диапазон сумм:</b>\n` +
            `От <b>${formatMoney(product.min_amount)}</b> до <b>${formatMoney(product.max_amount)}</b>\n\n` +
            `📈 <b>Комиссия сервиса:</b> <b>${feeText}</b>\n\n` +
            `Нажмите кнопку ниже, чтобы ввести сумму пополнения:`,
          keyboard: [
            [{ label: '💳 Ввести сумму пополнения', action: `buy_flexible_prompt_${product.id}` }],
            [{ label: '◀️ Назад в каталог', action: 'catalog' }],
          ],
        });
      }

      const availableStock = db.getAvailableStock(product);
      const isSoldOut = availableStock <= 0;

      if (!product.is_unlimited && !isSoldOut) {
        currentQty = Math.min(currentQty, availableStock);
      }

      const totalAmount = Math.round(product.price * currentQty * 100) / 100;
      const deliveryDesc = product.delivery_type === 'MANUAL'
        ? '✍️ Ручная выдача (администратор свяжется с вами)'
        : '⚡ Автовыдача (выдача ключей сразу после подтверждения чека)';

      const stockDisplay = product.is_unlimited
        ? 'много'
        : isSoldOut
        ? '0 шт. (Закончился / в брони)'
        : `${availableStock} шт.`;

      const cardKeyboard: any[] = [];
      if (isSoldOut) {
        cardKeyboard.push([{ label: '🚫 Нет в наличии', action: 'catalog' }]);
      } else {
        cardKeyboard.push([
          { label: '➖', action: `view_prod_${product.id}_${Math.max(1, currentQty - 1)}` },
          { label: `🔢 ${currentQty} шт.`, action: `view_prod_${product.id}_${currentQty}` },
          {
            label: '➕',
            action: `view_prod_${product.id}_${
              product.is_unlimited || currentQty < availableStock ? currentQty + 1 : currentQty
            }`,
          },
        ]);
        cardKeyboard.push([
          {
            label: `💳 Купить ${currentQty} шт. (${formatMoney(totalAmount)})`,
            action: `buy_prod_${product.id}_${currentQty}`,
          },
        ]);
      }
      cardKeyboard.push([{ label: '◀️ Назад в каталог', action: 'catalog' }]);

      return res.json({
        type: 'product_card',
        product,
        text:
          `📦 <b>${product.name}</b>\n\n` +
          `📝 <b>Описание:</b> ${product.description || 'Без описания'}\n` +
          `🚚 <b>Доставка:</b> ${deliveryDesc}\n` +
          `📊 <b>В наличии:</b> ${stockDisplay}\n` +
          `💰 <b>Цена за 1 шт:</b> ${formatMoney(product.price)}\n\n` +
          (!isSoldOut
            ? `🔢 <b>Выбрано:</b> ${currentQty} шт.\n💳 <b>Итого к оплате:</b> <b>${formatMoney(totalAmount)}</b>`
            : `⚠️ <i>Товар временно закончился.</i>`),
        keyboard: cardKeyboard,
      });
    }

    // Запрос ввода суммы пополнения в симуляторе
    if (action.startsWith('buy_flexible_prompt_')) {
      const prodId = Number(action.replace('buy_flexible_prompt_', ''));
      const product = db.getProductById(prodId) as any;
      if (!product) return res.json({ type: 'text', text: 'Товар не найден' });

      return res.json({
        type: 'flexible_prompt',
        product,
        text:
          `💳 <b>Пополнение «${product.name}»</b>\n\n` +
          `Диапазон сумм: от <b>${formatMoney(product.min_amount)}</b> до <b>${formatMoney(product.max_amount)}</b>\n` +
          `Комиссия: <b>${product.fee_percent > 0 ? `+${product.fee_percent}%` : '0%'}</b>\n\n` +
          `Введите сумму пополнения:`,
        keyboard: [
          [{ label: `Пополнить на ${formatMoney(product.min_amount)}`, action: `submit_flexible_${product.id}`, payload: { amount: product.min_amount } }],
          [{ label: `Пополнить на ${formatMoney(Math.min(product.max_amount, product.min_amount * 2 || 500))}`, action: `submit_flexible_${product.id}`, payload: { amount: Math.min(product.max_amount, product.min_amount * 2 || 500) } }],
          [{ label: '◀️ Назад к товару', action: `view_prod_${product.id}_1` }],
        ],
      });
    }

    // Обработка суммы пополнения
    if (action.startsWith('submit_flexible_')) {
      const activePending = db.hasActivePendingOrder(userId) as any;
      if (activePending) {
        return res.json({
          type: 'text',
          text:
            `⚠️ <b>У вас уже есть активный заказ #${activePending.id}!</b>\n\n` +
            `Сумма: <b>${formatMoney(activePending.amount)}</b>\n` +
            `Статус: <b>Ожидает оплаты / проверки</b>\n\n` +
            `Завершите или отмените текущий заказ перед созданием нового.`,
          keyboard: [
            [{ label: `🛑 Отменить заказ #${activePending.id}`, action: `cancel_order_${activePending.id}` }],
            [{ label: '◀️ В каталог', action: 'catalog' }],
          ],
        });
      }

      const prodId = Number(action.replace('submit_flexible_', ''));
      const product = db.getProductById(prodId) as any;
      if (!product) return res.json({ type: 'text', text: 'Товар не найден' });

      const enteredAmount = parseMoney(payload?.amount, product.min_amount);
      const feePercent = product.fee_percent || 0;
      const feeAmount = Math.round((enteredAmount * feePercent / 100) * 100) / 100;
      const totalAmount = Math.round((enteredAmount + feeAmount) * 100) / 100;

      const order = db.createOrder({
        user_id: userId,
        username,
        product_id: product.id,
        amount: totalAmount,
        base_amount: enteredAmount,
        fee_amount: feeAmount,
        fee_percent: feePercent,
        quantity: 1,
        reserve: false,
      }) as any;

      return res.json({
        type: 'comment_prompt',
        order,
        text:
          `💬 <b>Заказ #${order.id} на пополнение:</b>\n\n` +
          `💳 <b>Услуга:</b> ${product.name}\n` +
          `📥 <b>К зачислению:</b> <b>${formatMoney(enteredAmount)}</b>\n` +
          (feePercent > 0 ? `📈 <b>Комиссия:</b> +${feePercent}% (${formatMoney(feeAmount)})\n` : '') +
          `💰 <b>Итого к оплате:</b> <b>${formatMoney(totalAmount)}</b>\n\n` +
          `Укажите логин или аккаунт для зачисления или нажмите [Пропустить]:`,
        keyboard: [
          [{ label: '➡️ Пропустить комментарий', action: `skip_comment_${order.id}` }],
          [{ label: '🛑 Отменить заказ', action: `cancel_order_${order.id}` }],
        ],
      });
    }

    // Покупка с указанным QTY: buy_prod_ID_QTY
    if (action.startsWith('buy_prod_')) {
      const activePending = db.hasActivePendingOrder(userId) as any;
      if (activePending) {
        return res.json({
          type: 'text',
          text:
            `⚠️ <b>У вас уже есть активный заказ #${activePending.id}!</b>\n\n` +
            `Сумма: <b>${formatMoney(activePending.amount)}</b>\n` +
            `Статус: <b>Ожидает оплаты / проверки</b>\n\n` +
            `Завершите или отмените текущий заказ перед созданием нового.`,
          keyboard: [
            [{ label: `🛑 Отменить заказ #${activePending.id}`, action: `cancel_order_${activePending.id}` }],
            [{ label: '◀️ В каталог', action: 'catalog' }],
          ],
        });
      }

      const parts = action.replace('buy_prod_', '').split('_');
      const prodId = Number(parts[0]);
      const qty = Math.max(1, Number(parts[1]) || 1);

      const product = db.getProductById(prodId) as any;
      if (!product || product.is_sold || product.is_hidden) {
        return res.json({
          type: 'text',
          text: '❌ Товар уже продан или скрыт с витрины',
          keyboard: [[{ label: '◀️ В каталог', action: 'catalog' }]],
        });
      }

      const availableStock = db.getAvailableStock(product);
      if (!product.is_unlimited && qty > availableStock) {
        return res.json({
          type: 'text',
          text: `❌ Доступно только ${availableStock} шт.`,
          keyboard: [[{ label: '◀️ К товару', action: `view_prod_${prodId}_1` }]],
        });
      }

      const totalAmount = Math.round(product.price * qty * 100) / 100;

      // Создаем заказ с бронированием остатка
      const order = db.createOrder({
        user_id: userId,
        username,
        product_id: product.id,
        amount: totalAmount,
        base_amount: totalAmount,
        quantity: qty,
        buyer_comment: null,
        reserve: true,
      }) as any;

      return res.json({
        type: 'comment_prompt',
        order,
        text:
          `💬 <b>Комментарий к заказу #${order.id}:</b>\n\n` +
          `📦 Вы оформляете: <b>${product.name}</b> (${qty} шт.)\n` +
          `💰 Сумма к оплате: <b>${formatMoney(totalAmount)}</b>\n` +
          `🔒 <i>Товар забронирован на время оплаты</i>\n\n` +
          `Напишите комментарий к заказу или нажмите [Пропустить]:`,
        keyboard: [
          [{ label: '➡️ Пропустить комментарий', action: `skip_comment_${order.id}` }],
          [{ label: '🛑 Отменить заказ (снять бронь)', action: `cancel_order_${order.id}` }],
        ],
      });
    }

    // Отмена заказа покупателем
    if (action.startsWith('cancel_order_')) {
      const orderId = Number(action.replace('cancel_order_', ''));
      db.releaseProductReservation(orderId);
      return res.json({
        type: 'text',
        text: `🛑 Заказ #${orderId} отменен. Бронь товара снята.`,
        keyboard: [[{ label: '📦 В каталог', action: 'catalog' }]],
      });
    }

    if (action.startsWith('skip_comment_') || action.startsWith('send_comment_')) {
      let orderId: number;
      let comment: string | null = null;

      if (action.startsWith('skip_comment_')) {
        orderId = Number(action.replace('skip_comment_', ''));
      } else {
        orderId = Number(action.replace('send_comment_', ''));
        comment = payload?.comment || null;
        if (comment) db.updateOrderBuyerComment(orderId, comment);
      }

      const order = db.getOrderById(orderId) as any;
      if (!order) return res.json({ type: 'text', text: 'Заказ не найден' });

      const isFlex = order.product_type === 'FLEXIBLE';
      let breakdownText = '';
      if (isFlex && order.base_amount) {
        breakdownText =
          `📥 К зачислению: ${formatMoney(order.base_amount)}\n` +
          (order.fee_amount ? `📈 Комиссия: +${order.fee_percent}% (${formatMoney(order.fee_amount)})\n` : '') +
          `💰 Итого: <b>${formatMoney(order.amount)}</b>\n`;
      } else {
        breakdownText =
          `📦 Товар: ${order.product_name} (${order.quantity || 1} шт.)\n` +
          `💰 Сумма: <b>${formatMoney(order.amount)}</b>\n`;
      }

      return res.json({
        type: 'order_created',
        order,
        text:
          `🧾 <b>Заказ #${order.id} сформирован!</b>\n` +
          breakdownText +
          `🔒 <i>Товар забронирован</i>\n\n` +
          `💳 <b>Реквизиты:</b>\n${process.env.PAYMENT_DETAILS || 'Ozon / Альфа-Банк'}\n\n` +
          `📸 Отправьте фото или скриншот чека для проверки:`,
        keyboard: [
          [
            { label: '📸 Отправить чек', action: 'upload_receipt', payload: { orderId: order.id } },
            { label: '🚨 Тест фрода (Повторный чек)', action: 'upload_receipt', payload: { orderId: order.id, isDuplicateTest: true } },
          ],
          [{ label: '🛑 Отменить заказ', action: `cancel_order_${order.id}` }],
        ],
      });
    }

    if (action === 'upload_receipt') {
      const orderId = payload?.orderId;
      const receiptUniqueId = payload?.receiptUniqueId || (payload?.isDuplicateTest ? 'duplicate_fraud_receipt_111' : `receipt_hash_${orderId}`);

      // Проверка на повторный чек
      const existing = db.findOrderByReceiptUniqueId(receiptUniqueId) as any;
      if (existing && existing.id !== orderId) {
        return res.json({
          type: 'text',
          text:
            `❌ <b>Этот чек уже был использован в системе. Попытка обмана зафиксирована.</b>\n\n` +
            `Чек с таким идентификатором уже был прикреплен к заказу #${existing.id} (${existing.created_at}).\n` +
            `Администратор уведомлен о попытке повторного использования.`,
          keyboard: [
            [{ label: '🛑 Отменить заказ', action: `cancel_order_${orderId}` }],
            [{ label: '🏠 В главное меню', action: 'start' }],
          ],
        });
      }

      const order = db.attachReceipt(orderId, 'simulated_receipt_file_' + orderId, receiptUniqueId) as any;
      return res.json({
        type: 'receipt_uploaded',
        order,
        text:
          `✅ <b>Чек принят, ожидайте подтверждения администратором.</b>\n\n` +
          `Номер заказа: <b>#${order.id}</b>\n` +
          `Товар: <b>${order.product_name}</b> (${formatMoney(order.amount)})\n` +
          `🔑 file_unique_id: <code>${escapeHtml(receiptUniqueId)}</code>\n\n` +
          `Ожидайте проверки платежа!`,
        keyboard: [[{ label: '🏠 В главное меню', action: 'start' }]],
      });
    }

    if (action === 'my_orders') {
      const orders = db.getOrdersByUser(userId);
      let text = `🛍 <b>Ваши покупки (всего: ${orders.length}):</b>\n\n`;
      if (orders.length === 0) {
        text += 'У вас пока нет заказов. Выберите товар в каталоге!';
      } else {
        orders.slice(0, 8).forEach((o: any) => {
          let st = '⏳ На проверке';
          if (o.status === 'APPROVED') st = '✅ Выполнен';
          if (o.status === 'REJECTED') st = '❌ Отклонен';
          if (o.status === 'REFUNDED') st = '🔄 Возврат средств';

          text += `<b>#${o.id}</b> — ${o.product_name} (${formatMoney(o.amount)})\nСтатус: ${st}\n`;
          const keys = o.delivered_keys || o.seller_comment || o.product_secret_data;
          if (o.status === 'APPROVED' && keys) {
            text += `🔑 <b>Выданные данные:</b>\n<pre>${escapeHtml(keys)}</pre>\n`;
          }
          text += `━━━━━━━━━━━━━━━\n`;
        });
      }
      return res.json({
        type: 'text',
        text,
        keyboard: [[{ label: '◀️ В главное меню', action: 'start' }]],
      });
    }

    if (action === 'support') {
      return res.json({
        type: 'text',
        text: `💬 <b>Поддержка:</b>\nКонтакты: ${process.env.SUPPORT_CONTACT || '@l_dont_understand'}`,
        keyboard: [[{ label: '◀️ В главное меню', action: 'start' }]],
      });
    }

    res.json({ type: 'text', text: 'Команда обработана' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. СЕРВИРОВАНИЕ СТАТИКИ И VITE MIDDLEWARE
// ==========================================

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`📦 Магазин работает на SQLite базе данных.`);

    // Если указан реальный BOT_TOKEN, запускаем Telegram бота в фоне
    if (process.env.BOT_TOKEN && process.env.BOT_TOKEN !== 'DUMMY_TOKEN_NOT_CONFIGURED') {
      startBot();
    } else {
      console.log('💡 [BOT NOTE] Для подключения бота к Telegram укажите BOT_TOKEN в настройках.');
    }
  });
}

startServer();
