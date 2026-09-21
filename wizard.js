/**
 * wizard.js - Пошаговый мастер создания товаров и услуг с поддержкой отката (FSM BACK / CANCEL)
 * 
 * Точно следует ТЗ пользователя:
 * 1. Первый шаг: выбор типа лота (Штучный товар / Пополнение баланса)
 * 2. Ветка «Штучный товар»: Название -> Описание -> Категория -> Фикс. цена -> Выдача (Авто/Ручная) -> Проверка наличия (ДА/НЕТ) -> Итоговое подтверждение
 * 3. Ветка «Пополнение баланса / Гибкая услуга»: Название -> Описание -> Категория -> Диапазон сумм (дефис 50-50000) -> Настройка комиссии (% / ₽) -> Формат ввода (целые / копейки) -> Итоговое подтверждение
 * 4. На каждом шаге кнопки: [ ◀️ Шаг назад ] [ ❌ Отменить создание ]
 */

import { Markup } from 'telegraf';
import db, { parseMoney, formatMoney } from './db.js';

/**
 * Рендер экрана мастера на основе текущего шага
 */
export async function renderWizardStep(ctx, userStates, edit = true) {
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  if (!state || state.type !== 'ADMIN_WIZARD') return;

  const { step, data, history } = state;
  let text = '';
  let buttons = [];

  const backCancelRow = [];
  if (history && history.length > 0) {
    backCancelRow.push(Markup.button.callback('◀️ Шаг назад', 'wizard_back'));
  }
  backCancelRow.push(Markup.button.callback('❌ Отменить создание', 'wizard_cancel'));

  switch (step) {
    // ==========================================
    // 1. ПЕРВЫЙ ШАГ: ВЫБОР ТИПА ЛОТА
    // ==========================================
    case 'CHOOSE_TYPE': {
      text =
        `➕ <b>Создание нового лота: Выбор типа</b>\n\n` +
        `Выберите, какой тип товара или услуги вы хотите создать:\n\n` +
        `• <b>📦 Штучный товар</b>\n` +
        `Аккаунт, ключ, подписка или позиция с фиксированной ценой (моментальная авто-выдача или ручная выдача).\n\n` +
        `• <b>💳 Пополнение баланса / Гибкая услуга</b>\n` +
        `Steam, внутриигровая валюта, кошельки, где клиент сам вводит нужную сумму в заданном диапазоне с учетом вашей комиссии.`;

      buttons = [
        [Markup.button.callback('📦 Штучный товар', 'wizard_type_fixed')],
        [Markup.button.callback('💳 Пополнение баланса / Гибкая услуга', 'wizard_type_flexible')],
        backCancelRow,
      ];
      break;
    }

    // ==========================================
    // ВЕТКА «ШТУЧНЫЙ ТОВАР» (FIXED)
    // ==========================================
    case 'FIXED_NAME': {
      text =
        `📦 <b>Штучный товар (Шаг 1 из 6): Название</b>\n\n` +
        `Введите понятное название товара (например: <i>«Telegram Premium (3 месяца)»</i>):` +
        (data.name ? `\n\n<i>Текущее:</i> <code>${data.name}</code>` : '');
      buttons = [backCancelRow];
      break;
    }

    case 'FIXED_DESC': {
      text =
        `📝 <b>Штучный товар (Шаг 2 из 6): Описание</b>\n\n` +
        `Введите описание товара, условия гарантии или инструкцию для покупателя (отправьте <code>-</code> чтобы оставить пустым):` +
        (data.description ? `\n\n<i>Текущее:</i> <code>${data.description}</code>` : '');
      buttons = [backCancelRow];
      break;
    }

    case 'FIXED_CATEGORY': {
      const categories = db.getAllCategories ? db.getAllCategories() : [];
      text =
        `📁 <b>Штучный товар (Шаг 3 из 6): Выбор категории</b>\n\n` +
        `Выберите категорию из существующих или нажмите «Без категории»:\n\n` +
        (data.category_id
          ? `<i>Текущая:</i> <b>${(db.getCategoryById && db.getCategoryById(data.category_id)?.name) || 'ID ' + data.category_id}</b>\n\n`
          : '');

      const catButtons = [];
      for (const cat of categories) {
        catButtons.push([Markup.button.callback(`📁 ${cat.name}`, `wizard_cat_select_${cat.id}`)]);
      }
      catButtons.push([Markup.button.callback('🌐 Без категории', 'wizard_cat_none')]);
      catButtons.push(backCancelRow);
      buttons = catButtons;
      break;
    }

    case 'FIXED_PRICE': {
      text =
        `💰 <b>Штучный товар (Шаг 4 из 6): Фиксированная цена</b>\n\n` +
        `Введите стоимость за 1 шт. в рублях (поддерживаются числа с точкой или запятой, например: <code>499</code>, <code>499.99</code> или <code>1,02</code>):` +
        (data.price ? `\n\n<i>Текущая цена:</i> <b>${formatMoney(data.price)}</b>` : '');
      buttons = [backCancelRow];
      break;
    }

    case 'FIXED_DELIVERY': {
      text =
        `🚚 <b>Штучный товар (Шаг 5 из 6): Тип выдачи</b>\n\n` +
        `Выберите способ передачи товара покупателю:\n\n` +
        `• <b>⚡ Авто-выдача</b> — бот моментально отправляет ключи/данные из базы сразу после оплаты.\n` +
        `• <b>✍️ Ручная выдача</b> — вы лично отправляете товар покупателю или активируете услугу вручную.`;
      buttons = [
        [
          Markup.button.callback('⚡ Авто-выдача', 'wizard_delivery_auto'),
          Markup.button.callback('✍️ Ручная выдача', 'wizard_delivery_manual'),
        ],
        backCancelRow,
      ];
      break;
    }

    case 'FIXED_KEYS': {
      text =
        `🔑 <b>Авто-выдача: Список ключей / аккаунтов</b>\n\n` +
        `Отправьте ключи, аккаунты или данные (<b>каждый с новой строки</b>).\n` +
        `Количество на складе (stock) рассчитается автоматически по количеству строк:\n\n` +
        `<i>Пример:</i>\n<code>KEY-1111-AAAA\nKEY-2222-BBBB\nKEY-3333-CCCC</code>`;
      buttons = [backCancelRow];
      break;
    }

    case 'FIXED_STOCK': {
      text =
        `📊 <b>Ручная выдача: Количество в наличии</b>\n\n` +
        `Введите доступное количество (целое число) или напишите <code>inf</code> для бесконечного наличия:` +
        (data.is_unlimited ? '\n\n<i>Текущее: Бесконечно (inf)</i>' : data.stock ? `\n\n<i>Текущее: ${data.stock} шт.</i>` : '');
      buttons = [backCancelRow];
      break;
    }

    case 'FIXED_CHECK': {
      text =
        `🔍 <b>Штучный товар (Шаг 6 из 6): Проверка наличия</b>\n\n` +
        `Требовать ли подтверждение наличия перед оплатой?\n\n` +
        `• <b>ДА</b> — перед оплатой покупатель нажимает «Запросить наличие», администратор подтверждает наличие, и только затем клиенту выдаются реквизиты.\n` +
        `• <b>НЕТ</b> — покупатель может сразу перейти к оплате без предварительного запроса к продавцу.`;
      buttons = [
        [
          Markup.button.callback('✅ ДА (Требовать подтверждение)', 'wizard_check_yes'),
          Markup.button.callback('⚪ НЕТ (Сразу к оплате)', 'wizard_check_no'),
        ],
        backCancelRow,
      ];
      break;
    }

    case 'FIXED_CONFIRM': {
      const checkStatus = data.requires_availability_check
        ? '🟢 ДА (Требовать подтверждение)'
        : '⚪ НЕТ (Сразу к оплате)';
      const catObj = data.category_id ? db.getCategoryById(data.category_id) : null;
      const catLabel = catObj ? `📁 ${catObj.name}` : '🌐 Без категории';

      const stockLabel = data.delivery_type === 'AUTO'
        ? `${(data.secret_data || '').split('\n').filter(Boolean).length} шт. (по числу ключей)`
        : (data.is_unlimited ? 'Бесконечно (∞)' : `${data.stock} шт.`);

      text =
        `✅ <b>Проверьте данные штучного товара:</b>\n\n` +
        `📦 <b>Название:</b> ${data.name}\n` +
        `📁 <b>Категория:</b> ${catLabel}\n` +
        `📝 <b>Описание:</b> ${data.description || 'нет'}\n` +
        `💰 <b>Цена за 1 шт:</b> <b>${formatMoney(data.price)}</b>\n` +
        `🚚 <b>Тип выдачи:</b> ${data.delivery_type === 'AUTO' ? '⚡ Авто-выдача' : '✍️ Ручная выдача'}\n` +
        `📊 <b>Наличие:</b> ${stockLabel}\n` +
        `🔍 <b>Проверка наличия:</b> <b>${checkStatus}</b>\n\n` +
        `Опубликовать товар на витрине?`;
      buttons = [
        [Markup.button.callback('✅ Создать товар', 'wizard_confirm_save')],
        backCancelRow,
      ];
      break;
    }

    // ==========================================
    // ВЕТКА «ПОПОЛНЕНИЕ БАЛАНСА / ГИБКАЯ УСЛУГА» (FLEXIBLE)
    // ==========================================
    case 'FLEX_NAME': {
      text =
        `💳 <b>Пополнение баланса (Шаг 1 из 6): Название услуги</b>\n\n` +
        `Введите название услуги (например: <i>«Пополнение Steam РФ / СНГ»</i>):` +
        (data.name ? `\n\n<i>Текущее:</i> <code>${data.name}</code>` : '');
      buttons = [backCancelRow];
      break;
    }

    case 'FLEX_DESC': {
      text =
        `📝 <b>Пополнение баланса (Шаг 2 из 6): Описание / Инструкция</b>\n\n` +
        `Введите описание или инструкцию для покупателя (например, как указать логин или ограничения) или отправьте <code>-</code>:` +
        (data.description ? `\n\n<i>Текущее:</i> <code>${data.description}</code>` : '');
      buttons = [backCancelRow];
      break;
    }

    case 'FLEX_CATEGORY': {
      const categories = db.getAllCategories ? db.getAllCategories() : [];
      text =
        `📁 <b>Пополнение баланса (Шаг 3 из 6): Выбор категории</b>\n\n` +
        `Выберите категорию из существующих или нажмите «Без категории»:\n\n` +
        (data.category_id
          ? `<i>Текущая:</i> <b>${(db.getCategoryById && db.getCategoryById(data.category_id)?.name) || 'ID ' + data.category_id}</b>\n\n`
          : '');

      const catButtons = [];
      for (const cat of categories) {
        catButtons.push([Markup.button.callback(`📁 ${cat.name}`, `wizard_cat_select_${cat.id}`)]);
      }
      catButtons.push([Markup.button.callback('🌐 Без категории', 'wizard_cat_none')]);
      catButtons.push(backCancelRow);
      buttons = catButtons;
      break;
    }

    case 'FLEX_RANGE': {
      text =
        `📊 <b>Пополнение баланса (Шаг 4 из 6): Минимальная и максимальная сумма</b>\n\n` +
        `Введите диапазон сумм через дефис (например: <code>50-50000</code> или <code>100 - 15000</code>):` +
        (data.min_amount && data.max_amount ? `\n\n<i>Текущий диапазон:</i> <b>${formatMoney(data.min_amount)} – ${formatMoney(data.max_amount)}</b>` : '');
      buttons = [backCancelRow];
      break;
    }

    case 'FLEX_FEE_TYPE': {
      text =
        `📈 <b>Пополнение баланса (Шаг 5 из 6): Настройка комиссии</b>\n\n` +
        `Выберите способ начисления комиссии к сумме клиента:\n\n` +
        `• <b>📈 В процентах (%)</b> — например, +2% к сумме (1000 ₽ -> 1020 ₽).\n` +
        `• <b>➕ Фиксированная наценка (₽)</b> — например, +50 ₽ или +1.02 ₽ к любой сумме.`;
      buttons = [
        [
          Markup.button.callback('📈 В процентах (%)', 'wizard_fee_type_percent'),
          Markup.button.callback('➕ Фиксированная наценка (₽)', 'wizard_fee_type_fixed'),
        ],
        backCancelRow,
      ];
      break;
    }

    case 'FLEX_FEE_VALUE': {
      const isPercent = data.fee_type === 'PERCENT';
      text = isPercent
        ? `📈 <b>Комиссия в процентах (%)</b>\n\n` +
          `Введите процент комиссии (например: <code>2</code> для +2%, <code>2.5</code> для +2.5%, или <code>0</code> если без комиссии):` +
          (data.fee_value !== undefined ? `\n\n<i>Текущее:</i> <b>+${data.fee_value}%</b>` : '')
        : `➕ <b>Фиксированная наценка (₽)</b>\n\n` +
          `Введите фиксированную сумму наценки в рублях (например: <code>50</code>, <code>1.02</code> или <code>0</code>):` +
          (data.fee_value !== undefined ? `\n\n<i>Текущее:</i> <b>+${formatMoney(data.fee_value)}</b>` : '');
      buttons = [backCancelRow];
      break;
    }

    case 'FLEX_DECIMALS': {
      text =
        `⚙️ <b>Пополнение баланса (Шаг 6 из 6): Формат ввода клиентом</b>\n\n` +
        `Разрешать ли клиенту указывать копейки/дробные числа?\n\n` +
        `• <b>🔢 Только целые числа (100, 500 ₽)</b> — клиент может вводить только целые суммы.\n` +
        `• <b>🪙 Разрешить копейки / дробные (100.50 ₽)</b> — клиент может указать любую точную сумму с копейками (например: 100.50, 1.02 ₽).`;
      buttons = [
        [
          Markup.button.callback('🔢 Только целые числа (100, 500 ₽)', 'wizard_decimals_0'),
          Markup.button.callback('🪙 Разрешить копейки / дробные (100.50 ₽)', 'wizard_decimals_1'),
        ],
        backCancelRow,
      ];
      break;
    }

    case 'FLEX_CONFIRM': {
      const isPercent = data.fee_type === 'PERCENT';
      const feeLabel = (data.fee_value > 0)
        ? (isPercent ? `+${data.fee_value}%` : `+${formatMoney(data.fee_value)}`)
        : '0% (без наценки)';
      const decimalsLabel = data.allow_decimals
        ? '🪙 Разрешены копейки / дробные (100.50 ₽)'
        : '🔢 Только целые числа (100, 500 ₽)';
      const catObj = data.category_id ? db.getCategoryById(data.category_id) : null;
      const catLabel = catObj ? `📁 ${catObj.name}` : '🌐 Без категории';

      text =
        `✅ <b>Проверьте данные услуги пополнения:</b>\n\n` +
        `💳 <b>Название:</b> ${data.name}\n` +
        `📁 <b>Категория:</b> ${catLabel}\n` +
        `📝 <b>Описание:</b> ${data.description || 'нет'}\n` +
        `📊 <b>Диапазон сумм:</b> <b>${formatMoney(data.min_amount)} – ${formatMoney(data.max_amount)}</b>\n` +
        `📈 <b>Комиссия:</b> <b>${isPercent ? 'В процентах' : 'Фиксированная'} (${feeLabel})</b>\n` +
        `⚙️ <b>Формат ввода:</b> <b>${decimalsLabel}</b>\n\n` +
        `Создать и опубликовать услугу в каталоге?`;
      buttons = [
        [Markup.button.callback('✅ Создать услугу пополнения', 'wizard_confirm_save')],
        backCancelRow,
      ];
      break;
    }

    default:
      text = '⚠️ Неизвестный шаг мастера.';
      buttons = [[Markup.button.callback('❌ Отмена', 'wizard_cancel')]];
  }

  const keyboard = Markup.inlineKeyboard(buttons);

  try {
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
  } catch (err) {
    if (!err.message?.includes('message is not modified')) {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
  }
}

/**
 * Переход на следующий шаг с сохранением истории для кнопки «Шаг назад»
 */
export function pushWizardStep(userStates, userId, nextStep) {
  const state = userStates.get(userId);
  if (!state) return;
  state.history = state.history || [];
  state.history.push({ step: state.step, data: { ...state.data } });
  state.step = nextStep;
}

/**
 * Откат на предыдущий шаг (◀️ Шаг назад)
 */
export function popWizardStep(userStates, userId) {
  const state = userStates.get(userId);
  if (!state || !state.history || state.history.length === 0) return false;
  const previous = state.history.pop();
  state.step = previous.step;
  state.data = { ...state.data, ...previous.data };
  return true;
}

/**
 * Запуск мастера создания товара (Шаг 1: Выбор типа лота)
 */
export async function startWizard(ctx, userStates) {
  const userId = ctx.from.id;
  userStates.set(userId, {
    type: 'ADMIN_WIZARD',
    step: 'CHOOSE_TYPE',
    history: [],
    data: {
      product_type: 'FIXED',
      category_id: null,
      name: '',
      description: '',
      price: 0,
      delivery_type: 'AUTO',
      secret_data: '',
      stock: 1,
      is_unlimited: 0,
      min_amount: 50,
      max_amount: 50000,
      fee_type: 'PERCENT',
      fee_value: 0,
      allow_decimals: 0,
      fee_percent: 0,
      fee_fixed: 0,
      requires_availability_check: 0,
    },
  });

  await renderWizardStep(ctx, userStates, Boolean(ctx.callbackQuery));
}

/**
 * Финализация и сохранение созданного товара в БД
 */
export async function saveCreatedProduct(ctx, userStates) {
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  if (!state) return;

  const d = state.data;
  const created = db.createProduct({
    name: d.name,
    category_id: d.category_id || null,
    description: d.description,
    price: d.price,
    delivery_type: d.delivery_type,
    secret_data: d.secret_data,
    stock: d.stock,
    is_unlimited: d.is_unlimited,
    product_type: d.product_type,
    min_amount: d.min_amount,
    max_amount: d.max_amount,
    fee_type: d.fee_type || 'PERCENT',
    fee_value: d.fee_value !== undefined ? d.fee_value : (d.fee_percent || 0),
    allow_decimals: d.allow_decimals || 0,
    fee_percent: d.fee_percent || 0,
    fee_fixed: d.fee_fixed || 0,
    requires_availability_check: d.requires_availability_check || 0,
  });

  userStates.delete(userId);

  let summary = '';
  if (created.product_type === 'FLEXIBLE') {
    const isPercent = created.fee_type === 'PERCENT';
    const feeLabel = (created.fee_value > 0)
      ? (isPercent ? `+${created.fee_value}%` : `+${formatMoney(created.fee_value)}`)
      : '0% (без наценки)';
    const decimalsLabel = created.allow_decimals ? '🪙 Разрешены копейки (дробные)' : '🔢 Только целые числа';

    summary =
      `🎉 <b>Услуга пополнения баланса успешно создана!</b>\n\n` +
      `💳 <b>#${created.id}:</b> ${created.name}\n` +
      `📊 Диапазон: <b>${formatMoney(created.min_amount)} – ${formatMoney(created.max_amount)}</b>\n` +
      `📈 Наценка/комиссия: <b>${feeLabel}</b>\n` +
      `⚙️ Формат ввода клиента: <b>${decimalsLabel}</b>\n\n` +
      `Товар сразу доступен покупателям в каталоге!`;
  } else {
    const stockLabel = created.delivery_type === 'AUTO'
      ? `${created.stock} шт. (по числу ключей)`
      : (created.is_unlimited ? 'Бесконечно (∞)' : `${created.stock} шт.`);

    summary =
      `🎉 <b>Штучный товар успешно создан!</b>\n\n` +
      `📦 <b>#${created.id}:</b> ${created.name}\n` +
      `💰 Цена: <b>${formatMoney(created.price)}</b>\n` +
      `🚚 Тип: ${created.delivery_type === 'AUTO' ? '⚡ Авто-выдача' : '✍️ Ручная выдача'}\n` +
      `📊 В наличии: <b>${stockLabel}</b>\n` +
      `🔍 Проверка наличия: <b>${created.requires_availability_check ? 'ВКЛ' : 'ВЫКЛ'}</b>\n\n` +
      `Товар готов к продаже на витрине!`;
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Создать еще лот', 'admin_add_product')],
    [Markup.button.callback('📦 К списку товаров', 'admin_products_list')],
    [Markup.button.callback('⚙️ В панель управления', 'admin_panel')],
  ]);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(summary, { parse_mode: 'HTML', ...keyboard });
  } else {
    await ctx.reply(summary, { parse_mode: 'HTML', ...keyboard });
  }
}

export default {
  startWizard,
  renderWizardStep,
  pushWizardStep,
  popWizardStep,
  saveCreatedProduct,
};
