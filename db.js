/**
 * db.js - Локальная база данных SQLite для магазина цифровых товаров
 * Использует better-sqlite3 для высокой надежности и синхронного выполнения запросов.
 *
 * ФУНКЦИОНАЛ:
 * 1. Типы товаров (custom_products):
 *    - FIXED: Штучный товар с фиксированной ценой (дробные числа REAL, например 499.99 ₽, 1.02 ₽).
 *             Авто-выдача (AUTO) или Ручная выдача (MANUAL).
 *    - FLEXIBLE: Услуга пополнения баланса с динамической суммой от min_amount до max_amount
 *                и наценкой/комиссией (fee_percent %, fee_fixed ₽).
 *    - Дробные цены (REAL) для всех числовых расчетов.
 *    - Учет зарезервированного остатка (reserved_stock).
 *    - Видимость лота (is_hidden: 0 - на витрине, 1 - скрыт админом).
 * 2. Заказы (orders):
 *    - Поддержка дробных сумм (amount, base_amount, fee_amount REAL).
 *    - Покупка нескольких штук (quantity) для штучных товаров.
 *    - Резервация товара (is_reserved = 1) для штучных лотов.
 *    - Выданные ключи (delivered_keys).
 *    - Статусы: PENDING, APPROVED, REJECTED, REFUNDED.
 *    - Система возвратов (REFUND) с возможностью возврата остатка/ключей на склад.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Путь к файлу базы данных SQLite на диске (строго физический файл, не :memory:)
const DB_FILE_PATH = path.resolve(__dirname, 'shop.sqlite');

const dbDir = path.dirname(DB_FILE_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(DB_FILE_PATH, {
  verbose: process.env.NODE_ENV === 'development' ? console.log : null,
});

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

/**
 * Безопасное автоматическое добавление недостающих колонок при запуске приложения (автомиграция)
 * @param {string} table
 * @param {string} column
 * @param {string} definition
 */
export function addColumnIfNotExists(table, column, definition) {
  try {
    const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all();
    const columnExists = tableInfo.some(col => col.name === column);
    if (!columnExists) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      console.log(`[DB] Колонка ${column} успешно добавлена в таблицу ${table}`);
    }
  } catch (err) {
    console.error(`[DB] Ошибка при добавлении ${column} в ${table}:`, err.message);
  }
}

/**
 * Обратная совместимость для вызовов safeAddColumn(table, columnDef)
 * @param {string} table
 * @param {string} columnDef
 */
export function safeAddColumn(table, columnDef) {
  try {
    const parts = columnDef.trim().split(/\s+/);
    const colName = parts[0];
    const def = parts.slice(1).join(' ');
    addColumnIfNotExists(table, colName, def);
  } catch (e) {
    // В случае нестандартного синтаксиса пробуем прямой ALTER
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`).run();
    } catch (err) {}
  }
}

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ДРОБНЫХ ЧИСЕЛ И КОМИССИЙ
// ==========================================

/**
 * Парсинг дробного числа из строки с поддержкой точки и запятой
 * @param {string|number} val 
 * @param {number} defaultVal 
 * @returns {number}
 */
export function parseMoney(val, defaultVal = 0) {
  if (typeof val === 'number') return isNaN(val) ? defaultVal : Math.round(val * 100) / 100;
  if (!val) return defaultVal;
  const str = String(val).trim().replace(/\s+/g, '').replace(',', '.');
  const num = parseFloat(str);
  return isNaN(num) ? defaultVal : Math.round(num * 100) / 100;
}

/**
 * Форматирование числа в денежный вид с разделителями и округлением: 1 020.00 ₽ или 1 020.00 ₸
 * @param {number|string} val 
 * @param {string} [currencySymbol='₽']
 * @returns {string}
 */
export function formatMoney(val, currencySymbol = '₽') {
  const num = parseMoney(val, 0);
  const parts = num.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sym = currencySymbol ? String(currencySymbol).trim() : '₽';
  return `${intPart}.${parts[1]} ${sym}`;
}

/**
 * Форматирование комиссии: "+2%" или "+1.02 ₽"
 * Поддерживает вызов как formatFeeLabel(product), так и formatFeeLabel(feeType, feeValue)
 * @param {'PERCENT'|'FIXED'|Object} feeTypeOrProduct 
 * @param {number} [feeValue] 
 * @returns {string}
 */
export function formatFeeLabel(feeTypeOrProduct, feeValue) {
  let type = 'PERCENT';
  let val = 0;
  let sym = '₽';

  if (feeTypeOrProduct && typeof feeTypeOrProduct === 'object') {
    type = feeTypeOrProduct.fee_type === 'FIXED' ? 'FIXED' : 'PERCENT';
    val = typeof feeTypeOrProduct.fee_value === 'number'
      ? feeTypeOrProduct.fee_value
      : (parseMoney(feeTypeOrProduct.fee_value, 0) || parseMoney(feeTypeOrProduct.fee_percent, 0) || parseMoney(feeTypeOrProduct.fee_fixed, 0));
    // Если фиксированная комиссия, она добавляется в рублях к сумме перевода
    sym = '₽';
  } else {
    type = feeTypeOrProduct === 'FIXED' ? 'FIXED' : 'PERCENT';
    val = parseMoney(feeValue, 0);
  }

  if (val <= 0) return '0% (без комиссии)';
  if (type === 'PERCENT') {
    return `${val}%`;
  }
  return `${formatMoney(val, sym)}`;
}

/**
 * Расчет итоговой суммы и комиссии сервиса:
 * Для пополнений (FLEXIBLE):
 * - enteredAmount — это сумма в валюте пополнения (например, 1000 ₸ или 50 $).
 * - exchange_rate — курс пересчета 1 ед. валюты лота в рубли (₽).
 * - baseRub = enteredAmount * exchange_rate — базовая стоимость в рублях.
 * - Если fee_type == 'PERCENT': Итого (₽) = baseRub + (baseRub * (fee_value / 100))
 * - Если fee_type == 'FIXED': Итого (₽) = baseRub + fee_value
 * 
 * @param {Object} product
 * @param {number|string} enteredAmount
 * @returns {{ baseAmount: number, baseRub: number, feeAmount: number, totalAmount: number, feeType: 'PERCENT'|'FIXED', feeValue: number, feeBreakdownText: string, currencySymbol: string, exchangeRate: number }}
 */
export function calculateOrderFee(product, enteredAmount) {
  const baseAmount = parseMoney(enteredAmount, 0);
  const currencySymbol = (product?.currency_symbol && String(product.currency_symbol).trim()) || '₽';
  const exchangeRate = typeof product?.exchange_rate === 'number' && product.exchange_rate > 0
    ? product.exchange_rate
    : (parseMoney(product?.exchange_rate, 1) || 1.0);

  // Конвертация в базовые рубли
  const baseRub = Math.round((baseAmount * exchangeRate) * 100) / 100;

  const feeType = product?.fee_type === 'FIXED' ? 'FIXED' : 'PERCENT';
  const feeValue = typeof product?.fee_value === 'number' 
    ? product.fee_value 
    : (parseMoney(product?.fee_value, 0) || parseMoney(product?.fee_percent, 0) || parseMoney(product?.fee_fixed, 0));

  let feeAmount = 0;
  if (feeType === 'PERCENT') {
    feeAmount = Math.round((baseRub * (feeValue / 100)) * 100) / 100;
  } else {
    feeAmount = Math.round(feeValue * 100) / 100;
  }

  const totalAmount = Math.round((baseRub + feeAmount) * 100) / 100;

  let feeBreakdownText = '';
  if (feeValue > 0) {
    if (feeType === 'PERCENT') {
      feeBreakdownText = `+${feeValue}% (${formatMoney(feeAmount, '₽')})`;
    } else {
      feeBreakdownText = `+${formatMoney(feeAmount, '₽')}`;
    }
  } else {
    feeBreakdownText = '0 ₽ (без комиссии)';
  }

  return {
    baseAmount,
    baseRub,
    feeAmount,
    totalAmount,
    feeType,
    feeValue,
    feeBreakdownText,
    currencySymbol,
    exchangeRate,
  };
}

/**
 * Валидация ввода суммы клиентом с учетом allow_decimals и лимитов:
 * - Если allow_decimals == 0: только целые числа (при 100.5 -> ошибка)
 * - Если allow_decimals == 1: разрешены дробные/копейки (100, 100.50, 100,50)
 * 
 * @param {Object} product
 * @param {string|number} input
 * @returns {{ valid: boolean, amount?: number, error?: string }}
 */
export function validateFlexibleAmount(product, input) {
  if (input === null || input === undefined || String(input).trim() === '') {
    return { valid: false, error: 'Пожалуйста, введите сумму пополнения.' };
  }

  const rawStr = String(input).trim().replace(/\s+/g, '');
  const allowDecimals = Boolean(product?.allow_decimals);
  const curSym = (product?.currency_symbol && String(product.currency_symbol).trim()) || '₽';

  // Проверка на запрет дробных/копеек
  const hasSeparator = rawStr.includes('.') || rawStr.includes(',');
  if (!allowDecimals && hasSeparator) {
    const parts = rawStr.split(/[.,]/);
    const decimalDigits = parts[1] || '';
    if (decimalDigits && !/^0+$/.test(decimalDigits)) {
      return {
        valid: false,
        error: `Пожалуйста, введите целое число (например: 500 или 1000 ${curSym}).`,
      };
    }
  }

  const amount = parseMoney(rawStr, 0);

  if (isNaN(amount) || amount <= 0) {
    return {
      valid: false,
      error: 'Пожалуйста, введите корректное положительное число больше 0.',
    };
  }

  const min = parseMoney(product?.min_amount, 0);
  const max = parseMoney(product?.max_amount, 0);

  if (min > 0 && amount < min) {
    return {
      valid: false,
      error: `Сумма меньше минимальной! Минимальное пополнение: ${formatMoney(min, curSym)}.`,
    };
  }

  if (max > 0 && amount > max) {
    return {
      valid: false,
      error: `Сумма превышает максимальный лимит! Максимальное пополнение: ${formatMoney(max, curSym)}.`,
    };
  }

  return { valid: true, amount };
}

/**
 * Генератор популярных быстрых сумм в заданном диапазоне лимитов
 * @param {number} minAmount 
 * @param {number} maxAmount 
 * @param {boolean} [allowDecimals=false]
 * @returns {number[]}
 */
export function getPopularQuickAmounts(minAmount = 0, maxAmount = 50000, allowDecimals = false) {
  const min = parseMoney(minAmount, 0);
  const max = parseMoney(maxAmount, 50000);
  const standardPresets = [500, 1000, 2500, 5000, 10000];

  let filtered = standardPresets.filter((val) => val >= min && val <= max);

  if (filtered.length < 3) {
    // Дополняем минимальным значением или средними шагами
    const candidates = [
      min,
      Math.round((min * 2) / 10) * 10,
      Math.round((min + max) / 2),
      max,
    ].filter((v) => v >= min && v <= max && v > 0);

    const merged = Array.from(new Set([...filtered, ...candidates])).sort((a, b) => a - b);
    return merged.slice(0, 4);
  }

  return filtered.slice(0, 4);
}

/**
 * Инициализация таблиц, безопасных миграций без DROP TABLE и без дефолтных демо-товаров
 */
export function initDatabase() {
  // -1. Таблица пользователей для рассылки и аналитики
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      is_blocked INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Безопасное добавление новых колонок пользователей
  safeAddColumn('users', 'is_blocked INTEGER DEFAULT 0');

  // 0. Таблица категорий (создается ПЕРЕД custom_products)
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
  `);

  // 1. Таблица товаров (чистая витрина, наполняется ТОЛЬКО через /admin)
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      delivery_type TEXT NOT NULL DEFAULT 'AUTO',
      secret_data TEXT,
      stock INTEGER NOT NULL DEFAULT 1,
      reserved_stock INTEGER NOT NULL DEFAULT 0,
      is_unlimited INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      is_sold INTEGER NOT NULL DEFAULT 0,
      product_type TEXT NOT NULL DEFAULT 'FIXED',
      min_amount REAL NOT NULL DEFAULT 0,
      max_amount REAL NOT NULL DEFAULT 0,
      fee_type TEXT NOT NULL DEFAULT 'PERCENT',
      fee_value REAL NOT NULL DEFAULT 0,
      allow_decimals INTEGER NOT NULL DEFAULT 0,
      fee_percent REAL NOT NULL DEFAULT 0,
      fee_fixed REAL NOT NULL DEFAULT 0,
      requires_availability_check INTEGER NOT NULL DEFAULT 0,
      emoji TEXT DEFAULT '📦',
      currency_symbol TEXT DEFAULT '₽',
      exchange_rate REAL DEFAULT 1.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Безопасное автоматическое добавление колонок custom_products (автомиграция)
  addColumnIfNotExists('custom_products', 'emoji', "TEXT DEFAULT '📦'");
  addColumnIfNotExists('custom_products', 'currency_symbol', "TEXT DEFAULT '₽'");
  addColumnIfNotExists('custom_products', 'exchange_rate', 'REAL DEFAULT 1.0');
  addColumnIfNotExists('custom_products', 'requires_availability_check', 'INTEGER DEFAULT 0');
  addColumnIfNotExists('custom_products', 'category_id', 'INTEGER DEFAULT NULL');
  addColumnIfNotExists('custom_products', 'product_type', "TEXT DEFAULT 'FIXED'");
  addColumnIfNotExists('custom_products', 'min_amount', 'REAL DEFAULT 0');
  addColumnIfNotExists('custom_products', 'max_amount', 'REAL DEFAULT 0');
  addColumnIfNotExists('custom_products', 'fee_type', "TEXT DEFAULT 'PERCENT'");
  addColumnIfNotExists('custom_products', 'fee_value', 'REAL DEFAULT 0');
  addColumnIfNotExists('custom_products', 'allow_decimals', 'INTEGER DEFAULT 0');
  addColumnIfNotExists('custom_products', 'stock', 'INTEGER DEFAULT 1');
  addColumnIfNotExists('custom_products', 'reserved_stock', 'INTEGER DEFAULT 0');
  addColumnIfNotExists('custom_products', 'is_unlimited', 'INTEGER DEFAULT 0');
  addColumnIfNotExists('custom_products', 'is_hidden', 'INTEGER DEFAULT 0');
  addColumnIfNotExists('custom_products', 'fee_percent', 'REAL DEFAULT 0');
  addColumnIfNotExists('custom_products', 'fee_fixed', 'REAL DEFAULT 0');

  // Миграция старых комиссий в новую схему fee_type и fee_value
  try {
    db.exec(`
      UPDATE custom_products 
      SET fee_type = 'PERCENT', fee_value = fee_percent 
      WHERE (fee_value = 0 OR fee_value IS NULL) AND fee_percent > 0;
    `);
    db.exec(`
      UPDATE custom_products 
      SET fee_type = 'FIXED', fee_value = fee_fixed 
      WHERE (fee_value = 0 OR fee_value IS NULL) AND fee_fixed > 0;
    `);
  } catch (e) {}

  // Создание индексов для товаров
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_is_sold ON custom_products(is_sold);
    CREATE INDEX IF NOT EXISTS idx_products_is_hidden ON custom_products(is_hidden);
    CREATE INDEX IF NOT EXISTS idx_products_type ON custom_products(product_type);
  `);

  // 2. Таблица заказов
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      username TEXT,
      product_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      base_amount REAL,
      fee_amount REAL,
      fee_percent REAL,
      fee_type TEXT DEFAULT 'PERCENT',
      fee_value REAL DEFAULT 0,
      quantity INTEGER NOT NULL DEFAULT 1,
      buyer_comment TEXT,
      seller_comment TEXT,
      receipt_file_id TEXT,
      receipt_unique_id TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      is_reserved INTEGER NOT NULL DEFAULT 0,
      delivered_keys TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Безопасное автоматическое добавление колонок orders (автомиграция)
  addColumnIfNotExists('orders', 'receipt_unique_id', 'TEXT DEFAULT NULL');
  addColumnIfNotExists('orders', 'promo_code', 'TEXT DEFAULT NULL');
  addColumnIfNotExists('orders', 'discount_amount', 'REAL DEFAULT 0');
  addColumnIfNotExists('orders', 'quantity', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfNotExists('orders', 'is_reserved', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfNotExists('orders', 'delivered_keys', 'TEXT DEFAULT NULL');
  addColumnIfNotExists('orders', 'base_amount', 'REAL DEFAULT NULL');
  addColumnIfNotExists('orders', 'fee_amount', 'REAL DEFAULT NULL');
  addColumnIfNotExists('orders', 'fee_percent', 'REAL DEFAULT NULL');
  addColumnIfNotExists('orders', 'fee_type', "TEXT DEFAULT 'PERCENT'");
  addColumnIfNotExists('orders', 'fee_value', 'REAL DEFAULT 0');
  addColumnIfNotExists('orders', 'promo_id', 'INTEGER DEFAULT NULL');

  // Индексы для заказов
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_receipt_unique_id ON orders(receipt_unique_id);
  `);

  // 3. Таблица черного списка (Blacklist)
  db.exec(`
    CREATE TABLE IF NOT EXISTS blacklist (
      user_id INTEGER PRIMARY KEY,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 4. Таблица промокодов
  db.exec(`
    CREATE TABLE IF NOT EXISTS promocodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      discount_type TEXT NOT NULL,
      discount_value REAL NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'ALL',
      target_product_id INTEGER,
      max_uses INTEGER DEFAULT 0,
      current_uses INTEGER DEFAULT 0,
      min_order_amount REAL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 5. Таблица использования промокодов
  db.exec(`
    CREATE TABLE IF NOT EXISTS promo_usages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promo_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      order_id INTEGER,
      used_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_promocodes_code ON promocodes(code);
    CREATE INDEX IF NOT EXISTS idx_promo_usages_user_promo ON promo_usages(user_id, promo_id);
  `);

  // Очистка незавершенных старых черновиков без чеков (чтобы не блокировали витрину)
  try {
    const orphanOrders = db.prepare(`
      SELECT id, product_id, quantity, is_reserved 
      FROM orders 
      WHERE status = 'PENDING' AND (receipt_file_id IS NULL OR receipt_file_id = '')
    `).all();
    for (const ord of orphanOrders) {
      if (ord.is_reserved && ord.product_id) {
        db.prepare(`
          UPDATE custom_products 
          SET reserved_stock = MAX(0, reserved_stock - ?) 
          WHERE id = ?
        `).run(Math.max(1, ord.quantity || 1), Number(ord.product_id));
      }
      db.prepare(`
        UPDATE orders 
        SET status = 'CANCELLED', seller_comment = 'Автоматически отменен (черновик без чека)', is_reserved = 0 
        WHERE id = ?
      `).run(Number(ord.id));
    }
  } catch (e) {}

  // Синхронизация остатков AUTO товаров со строками secret_data
  try {
    const autoProducts = db.prepare("SELECT id, secret_data, stock FROM custom_products WHERE delivery_type = 'AUTO' AND product_type = 'FIXED'").all();
    for (const p of autoProducts) {
      if (p.secret_data) {
        const lines = p.secret_data.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
        if (p.stock !== lines.length) {
          db.prepare('UPDATE custom_products SET stock = ?, is_sold = ? WHERE id = ?').run(
            lines.length,
            lines.length > 0 ? 0 : 1,
            p.id
          );
        }
      }
    }
  } catch (e) {
    // Игнорируем авто-синхронизацию при старте
  }
}

// Запуск инициализации при импорте
initDatabase();

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ОСТАТКА
// ==========================================

/**
 * Получить фактический свободный остаток для продажи (с учетом брони)
 */
export function getAvailableStock(product) {
  if (!product) return 0;
  if (product.product_type === 'FLEXIBLE' || product.is_unlimited) return 999999;
  const stock = Number(product.stock) || 0;
  const reserved = Number(product.reserved_stock) || 0;
  return Math.max(0, stock - reserved);
}

// ==========================================
// МЕТОДЫ ДЛЯ РАБОТЫ С ТОВАРАМИ
// ==========================================

/**
 * Создать новый товар (штучный FIXED или услугу пополнения FLEXIBLE)
 */
export function createProduct({
  name,
  description = '',
  price = 0,
  delivery_type = 'AUTO',
  secret_data = null,
  stock = 1,
  is_unlimited = 0,
  product_type = 'FIXED',
  min_amount = 0,
  max_amount = 0,
  fee_type = 'PERCENT',
  fee_value = 0,
  allow_decimals = 0,
  fee_percent = 0,
  fee_fixed = 0,
  requires_availability_check = 0,
  category_id = null,
  emoji = '📦',
  currency_symbol = '₽',
  exchange_rate = 1.0,
}) {
  const pType = product_type === 'FLEXIBLE' ? 'FLEXIBLE' : 'FIXED';
  const deliveryType = pType === 'FLEXIBLE' ? 'MANUAL' : (delivery_type === 'MANUAL' ? 'MANUAL' : 'AUTO');
  
  let finalStock = Number(stock) || 1;
  let finalUnlimited = is_unlimited ? 1 : 0;
  let finalSecret = null;
  let isSold = 0;
  let finalPrice = parseMoney(price, 0);

  if (pType === 'FLEXIBLE') {
    finalUnlimited = 1;
    finalStock = 999999;
    finalSecret = null;
    isSold = 0;
    finalPrice = 0;
  } else if (deliveryType === 'AUTO') {
    finalUnlimited = 0;
    const lines = (secret_data || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    finalStock = lines.length;
    finalSecret = lines.join('\n');
    isSold = finalStock > 0 ? 0 : 1;
  } else {
    // MANUAL FIXED
    if (finalUnlimited) {
      finalStock = 999999;
      isSold = 0;
    } else {
      finalStock = Math.max(0, finalStock);
      isSold = finalStock > 0 ? 0 : 1;
    }
  }

  // Расчет типов комиссий
  const finalFeeType = fee_type === 'FIXED' ? 'FIXED' : 'PERCENT';
  let finalFeeValue = parseMoney(fee_value, 0);
  if (finalFeeValue === 0) {
    if (finalFeeType === 'PERCENT' && fee_percent) finalFeeValue = parseMoney(fee_percent, 0);
    if (finalFeeType === 'FIXED' && fee_fixed) finalFeeValue = parseMoney(fee_fixed, 0);
  }
  const finalFeePercent = finalFeeType === 'PERCENT' ? finalFeeValue : 0;
  const finalFeeFixed = finalFeeType === 'FIXED' ? finalFeeValue : 0;
  const finalAllowDecimals = allow_decimals ? 1 : 0;
  const finalReqCheck = requires_availability_check ? 1 : 0;
  const finalCategoryId = category_id ? Number(category_id) : null;
  const finalEmoji = emoji && String(emoji).trim() ? String(emoji).trim() : '📦';
  const finalCurrencySymbol = currency_symbol && String(currency_symbol).trim() ? String(currency_symbol).trim() : '₽';
  const finalExchangeRate = Math.max(0.000001, parseMoney(exchange_rate, 1.0));

  const stmt = db.prepare(`
    INSERT INTO custom_products (
      name, description, price, delivery_type, secret_data, 
      stock, reserved_stock, is_unlimited, is_hidden, is_sold,
      product_type, min_amount, max_amount, fee_type, fee_value, allow_decimals, fee_percent, fee_fixed,
      requires_availability_check, category_id, emoji, currency_symbol, exchange_rate
    )
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    String(name).trim(),
    description ? String(description).trim() : '',
    finalPrice,
    deliveryType,
    finalSecret,
    finalStock,
    finalUnlimited,
    isSold,
    pType,
    parseMoney(min_amount, 0),
    parseMoney(max_amount, 0),
    finalFeeType,
    finalFeeValue,
    finalAllowDecimals,
    finalFeePercent,
    finalFeeFixed,
    finalReqCheck,
    finalCategoryId,
    finalEmoji,
    finalCurrencySymbol,
    finalExchangeRate
  );

  return getProductById(result.lastInsertRowid);
}

/**
 * Получить список доступных к продаже товаров на витрине
 * (is_hidden = 0, is_sold = 0 и свободный остаток > 0 или FLEXIBLE)
 */
export function getAvailableProducts() {
  const products = db.prepare(`
    SELECT * FROM custom_products 
    WHERE is_hidden = 0 AND is_sold = 0
    ORDER BY id DESC
  `).all();

  return products.filter((p) => {
    if (p.product_type === 'FLEXIBLE') return true;
    if (p.is_unlimited) return true;
    return (p.stock - (p.reserved_stock || 0)) > 0;
  });
}

/**
 * Получить абсолютно все товары (для админ-панели)
 */
export function getAllProducts() {
  return db.prepare(`
    SELECT * FROM custom_products 
    ORDER BY id DESC
  `).all();
}

/**
 * Получить товар по ID
 */
export function getProductById(id) {
  return db.prepare(`
    SELECT * FROM custom_products WHERE id = ?
  `).get(Number(id));
}

/**
 * Обновить название товара
 */
export function updateProductName(productId, newName) {
  const name = String(newName || '').trim();
  if (!name) return getProductById(productId);

  db.prepare(`
    UPDATE custom_products 
    SET name = ? 
    WHERE id = ?
  `).run(name, Number(productId));

  return getProductById(productId);
}

/**
 * Обновить описание товара
 */
export function updateProductDescription(productId, newDescription) {
  const description = String(newDescription || '').trim();

  db.prepare(`
    UPDATE custom_products 
    SET description = ? 
    WHERE id = ?
  `).run(description, Number(productId));

  return getProductById(productId);
}

/**
 * Обновить цену товара (с поддержкой дробных чисел)
 */
export function updateProductPrice(productId, newPrice) {
  const price = Math.max(0.01, parseMoney(newPrice, 1));
  db.prepare(`
    UPDATE custom_products 
    SET price = ? 
    WHERE id = ?
  `).run(price, Number(productId));

  return getProductById(productId);
}

/**
 * Обновить минимальную сумму пополнения (FLEXIBLE)
 */
export function updateProductMinAmount(productId, minAmount) {
  const val = Math.max(0, parseMoney(minAmount, 0));
  db.prepare(`
    UPDATE custom_products 
    SET min_amount = ? 
    WHERE id = ?
  `).run(val, Number(productId));

  return getProductById(productId);
}

/**
 * Обновить максимальную сумму пополнения (FLEXIBLE)
 */
export function updateProductMaxAmount(productId, maxAmount) {
  const val = Math.max(0, parseMoney(maxAmount, 0));
  db.prepare(`
    UPDATE custom_products 
    SET max_amount = ? 
    WHERE id = ?
  `).run(val, Number(productId));

  return getProductById(productId);
}

/**
 * Обновить комиссию/наценку товара (FLEXIBLE):
 * Поддерживает вызовы:
 * - updateProductFee(id, 'FIXED', 50)
 * - updateProductFee(id, 'PERCENT', 2.5)
 * - updateProductFee(id, 2.5, 0) // обратная совместимость
 */
export function updateProductFee(productId, feeTypeOrPercent, feeValueOrFixed = 0) {
  let feeType = 'PERCENT';
  let feeValue = 0;

  if (feeTypeOrPercent === 'FIXED' || feeTypeOrPercent === 'PERCENT') {
    feeType = feeTypeOrPercent;
    feeValue = Math.max(0, parseMoney(feeValueOrFixed, 0));
  } else {
    // Обратная совместимость с (productId, feePercent, feeFixed)
    const percent = Math.max(0, parseMoney(feeTypeOrPercent, 0));
    const fixed = Math.max(0, parseMoney(feeValueOrFixed, 0));
    if (percent > 0 || fixed === 0) {
      feeType = 'PERCENT';
      feeValue = percent;
    } else {
      feeType = 'FIXED';
      feeValue = fixed;
    }
  }

  const feePercent = feeType === 'PERCENT' ? feeValue : 0;
  const feeFixed = feeType === 'FIXED' ? feeValue : 0;

  db.prepare(`
    UPDATE custom_products 
    SET fee_type = ?, fee_value = ?, fee_percent = ?, fee_fixed = ? 
    WHERE id = ?
  `).run(feeType, feeValue, feePercent, feeFixed, Number(productId));

  return getProductById(productId);
}

/**
 * Переключить или установить тип комиссии ('PERCENT' | 'FIXED')
 */
export function updateProductFeeType(productId, feeType) {
  const type = feeType === 'FIXED' ? 'FIXED' : 'PERCENT';
  const prod = getProductById(productId);
  const val = prod ? (prod.fee_value || 0) : 0;
  return updateProductFee(productId, type, val);
}

/**
 * Обновить числовое значение комиссии
 */
export function updateProductFeeValue(productId, feeValue) {
  const prod = getProductById(productId);
  const type = prod?.fee_type === 'FIXED' ? 'FIXED' : 'PERCENT';
  return updateProductFee(productId, type, feeValue);
}

/**
 * Обновить настройку формата ввода сумм для клиента (allow_decimals):
 * 0 — только целые числа при вводе суммы
 * 1 — разрешены дробные/копейки
 */
export function updateProductAllowDecimals(productId, allowDecimals) {
  const flag = allowDecimals ? 1 : 0;
  db.prepare(`
    UPDATE custom_products 
    SET allow_decimals = ? 
    WHERE id = ?
  `).run(flag, Number(productId));

  return getProductById(productId);
}

/**
 * Обновить настройку предварительной проверки наличия (requires_availability_check)
 * 1 — требуется подтверждение продавцом перед оплатой
 * 0 — стандартный заказ
 */
export function updateProductRequiresAvailabilityCheck(productId, requiresCheck) {
  const flag = requiresCheck ? 1 : 0;
  db.prepare(`
    UPDATE custom_products 
    SET requires_availability_check = ? 
    WHERE id = ?
  `).run(flag, Number(productId));

  return getProductById(productId);
}

/**
 * Переключить флаг проверки наличия (ВКЛ / ВЫКЛ)
 */
export function toggleProductRequiresAvailabilityCheck(productId) {
  const product = getProductById(productId);
  if (!product) return null;
  const nextVal = product.requires_availability_check ? 0 : 1;
  return updateProductRequiresAvailabilityCheck(productId, nextVal);
}

/**
 * Обновить эмодзи лота (флаг или значок)
 */
export function updateProductEmoji(productId, newEmoji) {
  const emoji = newEmoji && String(newEmoji).trim() ? String(newEmoji).trim() : '📦';
  db.prepare(`
    UPDATE custom_products
    SET emoji = ?
    WHERE id = ?
  `).run(emoji, Number(productId));

  return getProductById(productId);
}

/**
 * Обновить символ валюты лота (₸, ₺, $, грн, Stars и т.д.)
 */
export function updateProductCurrency(productId, newCurrencySymbol) {
  const sym = newCurrencySymbol && String(newCurrencySymbol).trim() ? String(newCurrencySymbol).trim() : '₽';
  db.prepare(`
    UPDATE custom_products
    SET currency_symbol = ?
    WHERE id = ?
  `).run(sym, Number(productId));

  return getProductById(productId);
}

/**
 * Обновить курс конвертации валюты лота к рублю (множитель)
 */
export function updateProductExchangeRate(productId, newExchangeRate) {
  const rate = Math.max(0.000001, parseMoney(newExchangeRate, 1.0));
  db.prepare(`
    UPDATE custom_products
    SET exchange_rate = ?
    WHERE id = ?
  `).run(rate, Number(productId));

  return getProductById(productId);
}

/**
 * Переключить тип доставки в один клик (AUTO <-> MANUAL) для штучных товаров
 */
export function toggleProductDeliveryType(productId) {
  const product = getProductById(productId);
  if (!product || product.product_type === 'FLEXIBLE') return product;

  const nextType = product.delivery_type === 'AUTO' ? 'MANUAL' : 'AUTO';

  if (nextType === 'AUTO') {
    const lines = (product.secret_data || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const newStock = lines.length;
    const isSold = newStock > 0 ? 0 : 1;

    db.prepare(`
      UPDATE custom_products 
      SET delivery_type = 'AUTO', is_unlimited = 0, stock = ?, is_sold = ? 
      WHERE id = ?
    `).run(newStock, isSold, Number(productId));
  } else {
    const newStock = Math.max(1, product.stock);
    db.prepare(`
      UPDATE custom_products 
      SET delivery_type = 'MANUAL', stock = ?, is_sold = 0 
      WHERE id = ?
    `).run(newStock, Number(productId));
  }

  return getProductById(productId);
}

/**
 * Переключить видимость товара (скрыть / показать на витрине)
 */
export function toggleProductVisibility(productId) {
  const product = getProductById(productId);
  if (!product) return null;

  const newHidden = product.is_hidden ? 0 : 1;
  db.prepare(`
    UPDATE custom_products 
    SET is_hidden = ? 
    WHERE id = ?
  `).run(newHidden, Number(productId));

  return getProductById(productId);
}

/**
 * Пополнить наличие товара
 */
export function replenishProductStock(productId, { additionalKeys = '', addStock = 0, setUnlimited = false } = {}) {
  const product = getProductById(productId);
  if (!product) return null;

  if (product.product_type === 'FLEXIBLE') {
    return product;
  }

  if (product.delivery_type === 'AUTO') {
    const existingLines = (product.secret_data || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const newLines = String(additionalKeys)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const mergedLines = [...existingLines, ...newLines];
    const newStock = mergedLines.length;
    const isSold = newStock > 0 ? 0 : 1;

    db.prepare(`
      UPDATE custom_products 
      SET secret_data = ?, stock = ?, is_sold = ? 
      WHERE id = ?
    `).run(mergedLines.join('\n'), newStock, isSold, Number(productId));

    return getProductById(productId);
  } else {
    if (setUnlimited) {
      db.prepare(`
        UPDATE custom_products 
        SET is_unlimited = 1, stock = 999999, is_sold = 0 
        WHERE id = ?
      `).run(Number(productId));
    } else {
      const added = Math.max(0, parseInt(addStock, 10) || 0);
      const currentStock = product.is_unlimited ? 0 : product.stock;
      const newStock = currentStock + added;
      const isSold = newStock > 0 ? 0 : 1;

      db.prepare(`
        UPDATE custom_products 
        SET is_unlimited = 0, stock = ?, is_sold = ? 
        WHERE id = ?
      `).run(newStock, isSold, Number(productId));
    }

    return getProductById(productId);
  }
}

/**
 * Удалить товар
 */
export function deleteProduct(id) {
  const stmt = db.prepare(`
    DELETE FROM custom_products WHERE id = ?
  `);
  return stmt.run(Number(id)).changes > 0;
}

/**
 * Пометить товар как проданный
 */
export function markProductSold(productId) {
  const stmt = db.prepare(`
    UPDATE custom_products 
    SET is_sold = 1 
    WHERE id = ?
  `);
  return stmt.run(Number(productId)).changes > 0;
}

// ==========================================
// МЕХАНИЗМ РЕЗЕРВАЦИИ ТОВАРА НА ВРЕМЯ ОПЛАТЫ
// ==========================================

/**
 * Забронировать количество товара на складе
 */
export function reserveProductStock(productId, qty = 1) {
  const product = getProductById(productId);
  if (!product || product.product_type === 'FLEXIBLE' || product.is_unlimited) {
    return;
  }
  const quantity = Math.max(1, parseInt(qty, 10) || 1);
  db.prepare(`
    UPDATE custom_products 
    SET reserved_stock = MAX(0, reserved_stock + ?) 
    WHERE id = ?
  `).run(quantity, Number(productId));
}

/**
 * Снять бронь с товара (при отмене заказа или отклонении чека)
 */
export function releaseProductReservation(orderId) {
  const order = db.prepare('SELECT id, product_id, quantity, is_reserved FROM orders WHERE id = ?').get(Number(orderId));
  if (!order || !order.is_reserved) return;

  const qty = Math.max(1, order.quantity || 1);

  db.prepare(`
    UPDATE custom_products 
    SET reserved_stock = MAX(0, reserved_stock - ?) 
    WHERE id = ?
  `).run(qty, Number(order.product_id));

  db.prepare(`
    UPDATE orders 
    SET is_reserved = 0 
    WHERE id = ?
  `).run(Number(order.id));
}

// ==========================================
// МЕТОДЫ ДЛЯ РАБОТЫ С ЗАКАЗАМИ
// ==========================================

/**
 * Создать заказ с поддержкой дробных чисел и пополнений
 * @param {Object} params
 * @param {number} params.user_id
 * @param {string} [params.username]
 * @param {number} params.product_id
 * @param {number} params.amount
 * @param {number|null} [params.base_amount]
 * @param {number|null} [params.fee_amount]
 * @param {number|null} [params.fee_percent]
 * @param {number} [params.quantity]
 * @param {string|null} [params.buyer_comment]
 * @param {boolean} [params.reserve]
 */
export function createOrder({
  user_id,
  username,
  product_id,
  amount,
  base_amount = null,
  fee_amount = null,
  fee_percent = null,
  fee_type = 'PERCENT',
  fee_value = null,
  quantity = 1,
  buyer_comment = null,
  reserve = true,
  promo_id = null,
  promo_code = null,
  discount_amount = 0,
  status = 'PENDING',
}) {
  const product = getProductById(product_id);
  const isFlexible = product?.product_type === 'FLEXIBLE';
  const qty = isFlexible ? 1 : Math.max(1, parseInt(quantity, 10) || 1);
  const shouldReserve = reserve && !isFlexible && !product?.is_unlimited;
  const isReserved = shouldReserve ? 1 : 0;

  if (shouldReserve) {
    reserveProductStock(product_id, qty);
  }

  const finalAmount = parseMoney(amount, 0);
  const finalBase = base_amount !== null ? parseMoney(base_amount, finalAmount) : finalAmount;
  const finalFee = fee_amount !== null ? parseMoney(fee_amount, 0) : 0;
  const finalFeePercent = fee_percent !== null ? parseMoney(fee_percent, 0) : 0;
  const finalFeeType = fee_type === 'FIXED' ? 'FIXED' : 'PERCENT';
  const finalFeeValue = fee_value !== null ? parseMoney(fee_value, 0) : (finalFeeType === 'PERCENT' ? finalFeePercent : finalFee);
  const finalPromoId = promo_id ? Number(promo_id) : null;
  const finalPromoCode = promo_code ? String(promo_code).trim().toUpperCase() : null;
  const finalDiscount = discount_amount ? parseMoney(discount_amount, 0) : 0;
  const finalStatus = status ? String(status).trim().toUpperCase() : 'PENDING';

  const stmt = db.prepare(`
    INSERT INTO orders (
      user_id, username, product_id, amount, base_amount, fee_amount, fee_percent,
      fee_type, fee_value, quantity, buyer_comment, status, is_reserved,
      promo_id, promo_code, discount_amount
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    Number(user_id),
    username ? String(username).trim() : null,
    Number(product_id),
    finalAmount,
    finalBase,
    finalFee,
    finalFeePercent,
    finalFeeType,
    finalFeeValue,
    qty,
    buyer_comment ? String(buyer_comment).trim() : null,
    finalStatus,
    isReserved,
    finalPromoId,
    finalPromoCode,
    finalDiscount
  );

  return getOrderById(result.lastInsertRowid);
}

/**
 * Получить заказ по ID со всеми данными товара
 */
export function getOrderById(id) {
  return db.prepare(`
    SELECT 
      o.*,
      p.name as product_name,
      p.description as product_description,
      p.price as product_price,
      p.delivery_type as product_delivery_type,
      p.secret_data as product_secret_data,
      p.stock as product_stock,
      p.reserved_stock as product_reserved_stock,
      p.is_unlimited as product_is_unlimited,
      p.is_hidden as product_is_hidden,
      p.product_type as product_type,
      p.min_amount as product_min_amount,
      p.max_amount as product_max_amount,
      p.fee_type as product_fee_type,
      p.fee_value as product_fee_value,
      p.allow_decimals as product_allow_decimals,
      p.fee_percent as product_fee_percent,
      p.fee_fixed as product_fee_fixed,
      p.requires_availability_check as product_requires_availability_check
    FROM orders o
    LEFT JOIN custom_products p ON o.product_id = p.id
    WHERE o.id = ?
  `).get(Number(id));
}

/**
 * Получить активный ожидающий чек заказ пользователя
 */
export function getActivePendingOrderByUser(userId) {
  return db.prepare(`
    SELECT 
      o.*,
      p.name as product_name,
      p.delivery_type as product_delivery_type,
      p.stock as product_stock,
      p.reserved_stock as product_reserved_stock,
      p.is_unlimited as product_is_unlimited,
      p.product_type as product_type
    FROM orders o
    LEFT JOIN custom_products p ON o.product_id = p.id
    WHERE o.user_id = ? AND o.status = 'PENDING' AND o.receipt_file_id IS NULL
    ORDER BY o.id DESC LIMIT 1
  `).get(Number(userId));
}

/**
 * Обновить комментарий покупателя
 */
export function updateOrderBuyerComment(orderId, comment) {
  const stmt = db.prepare(`
    UPDATE orders 
    SET buyer_comment = ? 
    WHERE id = ?
  `);
  stmt.run(comment ? String(comment).trim() : null, Number(orderId));
  return getOrderById(orderId);
}

/**
 * Поиск ранее использованного чека по его уникальному file_unique_id
 * @param {string} receiptUniqueId
 */
export function findOrderByReceiptUniqueId(receiptUniqueId) {
  if (!receiptUniqueId) return null;
  return db.prepare(`
    SELECT id, user_id, username, created_at, status, amount
    FROM orders 
    WHERE receipt_unique_id = ? AND status != 'CANCELLED'
    LIMIT 1
  `).get(String(receiptUniqueId));
}

/**
 * Получить активный заказ пользователя
 * СТРОГО по условию: status = 'PENDING' И receipt_file_id IS NOT NULL (чек отправлен и ждет проверки)
 * Если чека нет — заказ является не оформленным черновиком и не блокирует витрину
 * @param {number} userId
 */
export function getActiveOrder(userId) {
  return db.prepare(`
    SELECT * FROM orders 
    WHERE user_id = ? 
      AND UPPER(status) = 'PENDING' 
      AND receipt_file_id IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(Number(userId)) || null;
}

/**
 * Проверка наличия у пользователя активного незавершенного заказа в статусе PENDING
 * @param {number} userId
 */
export function hasActivePendingOrder(userId) {
  return getActiveOrder(userId);
}

/**
 * Принудительно отменить все активные PENDING заказы пользователя (для админ-панели)
 * @param {number} userId
 */
export function resetUserPendingOrders(userId) {
  const pendingOrders = db.prepare(`
    SELECT id, product_id, quantity, is_reserved 
    FROM orders 
    WHERE user_id = ? AND UPPER(status) = 'PENDING'
  `).all(Number(userId));

  for (const ord of pendingOrders) {
    if (ord.is_reserved && ord.product_id) {
      const qty = Math.max(1, ord.quantity || 1);
      db.prepare(`
        UPDATE custom_products 
        SET reserved_stock = MAX(0, reserved_stock - ?) 
        WHERE id = ?
      `).run(qty, Number(ord.product_id));
    }
    db.prepare(`
      UPDATE orders 
      SET status = 'CANCELLED', 
          seller_comment = 'Сброшен администратором через панель управления', 
          is_reserved = 0 
      WHERE id = ?
    `).run(Number(ord.id));
  }

  return pendingOrders.length;
}

/**
 * Получить список пользователей с текущими активными PENDING-заказами (с чеками)
 */
export function getUsersWithActiveOrders() {
  return db.prepare(`
    SELECT 
      user_id, 
      username, 
      COUNT(id) as pending_count, 
      MAX(id) as last_order_id, 
      MAX(created_at) as last_order_at,
      SUM(amount) as total_amount
    FROM orders
    WHERE UPPER(status) = 'PENDING' AND receipt_file_id IS NOT NULL
    GROUP BY user_id
    ORDER BY last_order_id DESC
    LIMIT 25
  `).all();
}

/**
 * Автоматическая отмена заказов по таймауту (20 минут) со снятием брони
 * @param {number} [timeoutMinutes=20]
 */
export function cancelExpiredOrders(timeoutMinutes = 20) {
  const expired = db.prepare(`
    SELECT id, product_id, quantity, is_reserved, user_id, created_at
    FROM orders
    WHERE status = 'PENDING' 
      AND receipt_file_id IS NULL
      AND (strftime('%s', 'now') - strftime('%s', created_at)) > (? * 60)
  `).all(Number(timeoutMinutes));

  for (const ord of expired) {
    if (ord.is_reserved) {
      releaseProductReservation(ord.id);
    }
    db.prepare(`
      UPDATE orders 
      SET status = 'CANCELLED', 
          seller_comment = 'Автоматически отменен системой по таймауту (чек не отправлен за 20 мин)',
          is_reserved = 0
      WHERE id = ?
    `).run(Number(ord.id));
  }

  return expired;
}

/**
 * Добавить пользователя в черный список
 * @param {number} userId
 * @param {string} [reason]
 */
export function addToBlacklist(userId, reason = 'Нарушение правил магазина') {
  db.prepare(`
    INSERT INTO blacklist (user_id, reason, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, created_at = CURRENT_TIMESTAMP
  `).run(Number(userId), String(reason).trim());
  return true;
}

/**
 * Удалить пользователя из черного списка
 * @param {number} userId
 */
export function removeFromBlacklist(userId) {
  const res = db.prepare(`DELETE FROM blacklist WHERE user_id = ?`).run(Number(userId));
  return res.changes > 0;
}

/**
 * Проверка, заблокирован ли пользователь
 * @param {number} userId
 */
export function isBlacklisted(userId) {
  return db.prepare(`
    SELECT user_id, reason, created_at 
    FROM blacklist 
    WHERE user_id = ?
  `).get(Number(userId)) || null;
}

/**
 * Получить весь черный список
 */
export function getAllBlacklisted() {
  return db.prepare(`
    SELECT * FROM blacklist 
    ORDER BY created_at DESC
  `).all();
}

/**
 * Отмена заказа с возвратом брони
 * @param {number} orderId
 * @param {string} [reason]
 */
export function cancelOrder(orderId, reason = 'Заказ отменен') {
  releaseProductReservation(orderId);
  db.prepare(`
    UPDATE orders 
    SET status = 'CANCELLED', seller_comment = ?, is_reserved = 0 
    WHERE id = ?
  `).run(reason ? String(reason).trim() : 'Заказ отменен', Number(orderId));
  return getOrderById(orderId);
}

/**
 * Обновить статус заказа
 * @param {number} orderId
 * @param {string} status
 * @param {string|null} [sellerComment]
 */
export function updateOrderStatus(orderId, status, sellerComment = null) {
  const stmt = db.prepare(`
    UPDATE orders 
    SET status = ?, seller_comment = COALESCE(?, seller_comment) 
    WHERE id = ?
  `);
  stmt.run(status, sellerComment, Number(orderId));
  return getOrderById(orderId);
}

/**
 * Прикрепить квитанцию к заказу с защитой от повторов (receipt_unique_id)
 * @param {number} orderId
 * @param {string} receiptFileId
 * @param {string|null} [receiptUniqueId]
 */
export function attachReceipt(orderId, receiptFileId, receiptUniqueId = null) {
  const stmt = db.prepare(`
    UPDATE orders 
    SET receipt_file_id = ?, receipt_unique_id = ? 
    WHERE id = ?
  `);
  stmt.run(String(receiptFileId), receiptUniqueId ? String(receiptUniqueId) : null, Number(orderId));
  return getOrderById(orderId);
}

/**
 * Списание товара и выдача qty ключей при подтверждении заказа
 */
export function processProductDeliveryOnApproval(orderOrProductId, optionalQty = null) {
  let product = null;
  let order = null;
  let qty = 1;

  const potentialOrder = getOrderById(orderOrProductId);
  if (potentialOrder && potentialOrder.user_id) {
    order = potentialOrder;
    product = getProductById(order.product_id);
    qty = Math.max(1, order.quantity || 1);
  } else {
    product = getProductById(orderOrProductId);
    qty = Math.max(1, optionalQty || 1);
  }

  if (!product) {
    return {
      givenKey: null,
      givenKeys: null,
      remainingStock: 0,
      isSoldOut: true,
      deliveryType: 'AUTO',
      isUnlimited: false,
      quantity: qty,
    };
  }

  // Для гибких пополнений (FLEXIBLE) склад не списывается
  if (product.product_type === 'FLEXIBLE') {
    if (order && order.id) {
      db.prepare('UPDATE orders SET is_reserved = 0 WHERE id = ?').run(Number(order.id));
    }
    return {
      givenKey: null,
      givenKeys: null,
      remainingStock: 999999,
      isSoldOut: false,
      deliveryType: 'MANUAL',
      isUnlimited: true,
      quantity: 1,
    };
  }

  // Снимаем бронь с лота
  db.prepare(`
    UPDATE custom_products 
    SET reserved_stock = MAX(0, reserved_stock - ?) 
    WHERE id = ?
  `).run(qty, Number(product.id));

  if (order && order.id) {
    db.prepare('UPDATE orders SET is_reserved = 0 WHERE id = ?').run(Number(order.id));
  }

  let givenKeys = [];
  let newStock = product.stock;
  let newSecretData = product.secret_data;
  let isSold = product.is_sold;

  if (product.delivery_type === 'AUTO') {
    const lines = (product.secret_data || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    for (let i = 0; i < qty; i++) {
      if (lines.length > 0) {
        givenKeys.push(lines.shift());
      }
    }

    newSecretData = lines.join('\n');
    newStock = lines.length;
    isSold = newStock <= 0 ? 1 : 0;

    db.prepare(`
      UPDATE custom_products 
      SET secret_data = ?, stock = ?, is_sold = ? 
      WHERE id = ?
    `).run(newSecretData, newStock, isSold, Number(product.id));

    const keysString = givenKeys.join('\n');

    if (order && order.id) {
      db.prepare(`
        UPDATE orders 
        SET delivered_keys = ? 
        WHERE id = ?
      `).run(keysString, Number(order.id));
    }

    return {
      givenKey: keysString || givenKeys[0] || null,
      givenKeys: keysString,
      remainingStock: newStock,
      isSoldOut: isSold === 1,
      deliveryType: 'AUTO',
      isUnlimited: false,
      quantity: qty,
    };
  } else {
    // MANUAL
    if (!product.is_unlimited) {
      newStock = Math.max(0, product.stock - qty);
      isSold = newStock <= 0 ? 1 : 0;

      db.prepare(`
        UPDATE custom_products 
        SET stock = ?, is_sold = ? 
        WHERE id = ?
      `).run(newStock, isSold, Number(product.id));
    }

    return {
      givenKey: null,
      givenKeys: null,
      remainingStock: product.is_unlimited ? 999999 : newStock,
      isSoldOut: !product.is_unlimited && newStock <= 0,
      deliveryType: 'MANUAL',
      isUnlimited: Boolean(product.is_unlimited),
      quantity: qty,
    };
  }
}

/**
 * Подтвердить заказ администратором
 * @param {number} orderId
 * @param {string|null} [sellerComment]
 * @param {string|null} [deliveredKeys]
 */
export function approveOrder(orderId, sellerComment = null, deliveredKeys = null) {
  const order = getOrderById(orderId);
  if (!order) return null;

  if (order.is_reserved) {
    releaseProductReservation(orderId);
  }

  const finalDelivered = deliveredKeys || order.delivered_keys || null;

  const stmt = db.prepare(`
    UPDATE orders 
    SET status = 'APPROVED', seller_comment = ?, delivered_keys = COALESCE(delivered_keys, ?) 
    WHERE id = ?
  `);
  stmt.run(
    sellerComment ? String(sellerComment).trim() : null,
    finalDelivered ? String(finalDelivered).trim() : null,
    Number(orderId)
  );

  // Запись использования промокода при успешном подтверждении
  if (order.promo_id) {
    recordPromoUsage(order.promo_id, order.user_id, order.id);
  }

  return getOrderById(orderId);
}

/**
 * Отклонить заказ администратором (со снятием брони)
 */
export function rejectOrder(orderId, sellerComment = 'Оплата не подтверждена') {
  releaseProductReservation(orderId);

  const stmt = db.prepare(`
    UPDATE orders 
    SET status = 'REJECTED', seller_comment = ?, is_reserved = 0 
    WHERE id = ?
  `);
  stmt.run(sellerComment ? String(sellerComment).trim() : 'Оплата не подтверждена', Number(orderId));
  return getOrderById(orderId);
}

/**
 * Оформить возврат (REFUND) по заказу
 * @param {number} orderId 
 * @param {object} options { restock: boolean }
 */
export function refundOrder(orderId, { restock = false } = {}) {
  const order = getOrderById(orderId);
  if (!order) throw new Error('Заказ не найден');

  if (order.status === 'REFUNDED') {
    return order;
  }

  if (order.is_reserved) {
    releaseProductReservation(orderId);
  }

  // Если админ выбрал "Да, вернуть ключи в наличие" и это не услуга
  if (restock && order.product_id && order.product_type !== 'FLEXIBLE') {
    const product = getProductById(order.product_id);
    if (product) {
      if (product.delivery_type === 'AUTO') {
        const keysToRestore = (order.delivered_keys || '')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

        if (keysToRestore.length > 0) {
          const currentKeys = (product.secret_data || '')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);

          const merged = [...currentKeys, ...keysToRestore];
          const newStock = merged.length;

          db.prepare(`
            UPDATE custom_products 
            SET secret_data = ?, stock = ?, is_sold = 0 
            WHERE id = ?
          `).run(merged.join('\n'), newStock, Number(product.id));
        }
      } else {
        // MANUAL
        if (!product.is_unlimited) {
          const returnQty = Math.max(1, order.quantity || 1);
          const newStock = product.stock + returnQty;

          db.prepare(`
            UPDATE custom_products 
            SET stock = ?, is_sold = 0 
            WHERE id = ?
          `).run(newStock, Number(product.id));
        }
      }
    }
  }

  db.prepare(`
    UPDATE orders 
    SET status = 'REFUNDED', is_reserved = 0 
    WHERE id = ?
  `).run(Number(orderId));

  return getOrderById(orderId);
}

/**
 * Получить историю заказов пользователя
 */
export function getOrdersByUser(userId) {
  return db.prepare(`
    SELECT 
      o.*,
      p.name as product_name,
      p.delivery_type as product_delivery_type,
      p.secret_data as product_secret_data,
      p.product_type as product_type
    FROM orders o
    LEFT JOIN custom_products p ON o.product_id = p.id
    WHERE o.user_id = ? 
    ORDER BY o.id DESC
  `).all(Number(userId));
}

/**
 * Получить все заказы (для админки)
 */
export function getAllOrders({ limit = 50 } = {}) {
  return db.prepare(`
    SELECT 
      o.*,
      p.name as product_name,
      p.delivery_type as product_delivery_type,
      p.product_type as product_type
    FROM orders o
    LEFT JOIN custom_products p ON o.product_id = p.id
    ORDER BY o.id DESC
    LIMIT ?
  `).all(Math.max(1, limit));
}

/**
 * Получить выполненные заказы (доступные для возврата)
 */
export function getApprovedOrders({ limit = 30 } = {}) {
  return db.prepare(`
    SELECT 
      o.*,
      p.name as product_name,
      p.delivery_type as product_delivery_type,
      p.product_type as product_type
    FROM orders o
    LEFT JOIN custom_products p ON o.product_id = p.id
    WHERE o.status = 'APPROVED'
    ORDER BY o.id DESC
    LIMIT ?
  `).all(Math.max(1, limit));
}

/**
 * Получить общую статистику
 */
export function getDatabaseStats() {
  const totalOrders = db.prepare('SELECT COUNT(*) as cnt FROM orders').get().cnt;
  const approvedStats = db.prepare("SELECT COUNT(*) as cnt, SUM(amount) as total_sum FROM orders WHERE status = 'APPROVED'").get();
  const pendingOrders = db.prepare("SELECT COUNT(*) as cnt FROM orders WHERE status = 'PENDING' AND receipt_file_id IS NOT NULL").get().cnt;
  const refundedOrders = db.prepare("SELECT COUNT(*) as cnt FROM orders WHERE status = 'REFUNDED'").get().cnt;
  const availableProducts = db.prepare('SELECT COUNT(*) as cnt FROM custom_products WHERE is_sold = 0 AND is_hidden = 0 AND (product_type = \'FLEXIBLE\' OR is_unlimited = 1 OR stock > 0)').get().cnt;
  const soldProducts = db.prepare('SELECT COUNT(*) as cnt FROM custom_products WHERE product_type = \'FIXED\' AND (is_sold = 1 OR (is_unlimited = 0 AND stock <= 0))').get().cnt;

  return {
    totalOrders,
    totalRevenue: Math.round((approvedStats.total_sum || 0) * 100) / 100,
    approvedCount: approvedStats.cnt,
    pendingOrders,
    refundedOrders,
    availableProducts,
    soldProducts,
  };
}

// ==========================================
// СИСТЕМА ПРОМОКОДОВ (PROMOCODES)
// ==========================================

/**
 * Создать промокод
 */
export function createPromocode({
  code,
  discount_type,
  discount_value,
  target_type = 'ALL',
  target_product_id = null,
  max_uses = 0,
  min_order_amount = 0,
}) {
  const cleanCode = String(code).trim().toUpperCase();
  const discType = discount_type === 'PERCENT' ? 'PERCENT' : 'FIXED';
  const discVal = parseMoney(discount_value, 0);
  const targetType = target_type === 'SPECIFIC' ? 'SPECIFIC' : 'ALL';
  const targetProdId = targetType === 'SPECIFIC' && target_product_id ? Number(target_product_id) : null;
  const maxUses = Math.max(0, parseInt(max_uses, 10) || 0);
  const minAmount = parseMoney(min_order_amount, 0);

  const stmt = db.prepare(`
    INSERT INTO promocodes (
      code, discount_type, discount_value, target_type, target_product_id,
      max_uses, current_uses, min_order_amount, is_active
    )
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1)
  `);
  const result = stmt.run(cleanCode, discType, discVal, targetType, targetProdId, maxUses, minAmount);
  return getPromocodeById(result.lastInsertRowid);
}

/**
 * Получить промокод по ID
 */
export function getPromocodeById(id) {
  return db.prepare(`
    SELECT p.*, prod.name as target_product_name
    FROM promocodes p
    LEFT JOIN custom_products prod ON p.target_product_id = prod.id
    WHERE p.id = ?
  `).get(Number(id)) || null;
}

/**
 * Получить промокод по коду
 */
export function getPromocodeByCode(code) {
  if (!code) return null;
  return db.prepare(`
    SELECT p.*, prod.name as target_product_name
    FROM promocodes p
    LEFT JOIN custom_products prod ON p.target_product_id = prod.id
    WHERE UPPER(p.code) = UPPER(?)
    LIMIT 1
  `).get(String(code).trim()) || null;
}

/**
 * Получить все промокоды (для админки)
 */
export function getAllPromocodes() {
  return db.prepare(`
    SELECT p.*, prod.name as target_product_name
    FROM promocodes p
    LEFT JOIN custom_products prod ON p.target_product_id = prod.id
    ORDER BY p.id DESC
  `).all();
}

/**
 * Включить / выключить промокод
 */
export function togglePromocodeActive(id) {
  const promo = getPromocodeById(id);
  if (!promo) return null;
  const newStatus = promo.is_active ? 0 : 1;
  db.prepare('UPDATE promocodes SET is_active = ? WHERE id = ?').run(newStatus, Number(id));
  return getPromocodeById(id);
}

/**
 * Удалить промокод
 */
export function deletePromocode(id) {
  db.prepare('DELETE FROM promo_usages WHERE promo_id = ?').run(Number(id));
  const res = db.prepare('DELETE FROM promocodes WHERE id = ?').run(Number(id));
  return res.changes > 0;
}

/**
 * Проверка, использовал ли пользователь данный промокод
 */
export function hasUserUsedPromo(userId, promoId) {
  const row = db.prepare(`
    SELECT id FROM promo_usages
    WHERE user_id = ? AND promo_id = ?
    LIMIT 1
  `).get(Number(userId), Number(promoId));
  return Boolean(row);
}

/**
 * Записать использование промокода
 */
export function recordPromoUsage(promoId, userId, orderId = null) {
  try {
    const promo = getPromocodeById(promoId);
    if (!promo) return;

    db.prepare(`
      INSERT INTO promo_usages (promo_id, user_id, order_id)
      VALUES (?, ?, ?)
    `).run(Number(promoId), Number(userId), orderId ? Number(orderId) : null);

    db.prepare(`
      UPDATE promocodes
      SET current_uses = current_uses + 1
      WHERE id = ?
    `).run(Number(promoId));
  } catch (err) {
    console.error('[PROMO USAGE ERROR]', err.message);
  }
}

/**
 * Валидация промокода для покупателя
 */
export function validatePromocode(code, userId, productId, orderAmount) {
  if (!code || typeof code !== 'string') {
    return { valid: false, error: 'Введите промокод' };
  }
  const cleanCode = code.trim().toUpperCase();
  const promo = getPromocodeByCode(cleanCode);

  if (!promo) {
    return { valid: false, error: 'Промокод не существует' };
  }

  if (!promo.is_active) {
    return { valid: false, error: 'Этот промокод отключен или недействителен' };
  }

  if (promo.max_uses > 0 && promo.current_uses >= promo.max_uses) {
    return { valid: false, error: 'Промокод закончился' };
  }

  if (hasUserUsedPromo(userId, promo.id)) {
    return { valid: false, error: 'Вы уже использовали этот промокод' };
  }

  if (promo.target_type === 'SPECIFIC' && promo.target_product_id) {
    if (Number(promo.target_product_id) !== Number(productId)) {
      return { valid: false, error: 'Этот промокод не действует на данный товар' };
    }
  }

  const amt = parseMoney(orderAmount, 0);
  if (promo.min_order_amount > 0 && amt < promo.min_order_amount) {
    return { valid: false, error: `Минимальная сумма для промокода: ${formatMoney(promo.min_order_amount)}` };
  }

  let discount = 0;
  if (promo.discount_type === 'FIXED') {
    discount = parseMoney(promo.discount_value, 0);
  } else if (promo.discount_type === 'PERCENT') {
    discount = Math.round((amt * promo.discount_value / 100) * 100) / 100;
  }

  // Сумма к оплате не может быть меньше 1 ₽
  const maxAllowedDiscount = Math.max(0, Math.round((amt - 1) * 100) / 100);
  const finalDiscount = Math.min(discount, maxAllowedDiscount);
  const finalAmount = Math.max(1, Math.round((amt - finalDiscount) * 100) / 100);

  return {
    valid: true,
    promo,
    discountAmount: finalDiscount,
    finalAmount,
  };
}

// ==========================================
// КАТЕГОРИИ (CATEGORIES) И ПОИСК ТОВАРОВ
// ==========================================

/**
 * Создать категорию
 */
export function createCategory(name, sortOrder = 0) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Название категории не может быть пустым');
  const stmt = db.prepare(`
    INSERT INTO categories (name, sort_order)
    VALUES (?, ?)
  `);
  const res = stmt.run(cleanName, Number(sortOrder) || 0);
  return getCategoryById(res.lastInsertRowid);
}

/**
 * Получить категорию по ID
 */
export function getCategoryById(id) {
  if (!id) return null;
  return db.prepare(`SELECT * FROM categories WHERE id = ?`).get(Number(id)) || null;
}

/**
 * Получить все категории с сортировкой по sort_order ASC, id ASC
 */
export function getAllCategories() {
  return db.prepare(`
    SELECT c.*, 
      (SELECT COUNT(*) FROM custom_products p WHERE p.category_id = c.id AND p.is_hidden = 0 AND p.is_sold = 0) as active_count,
      (SELECT COUNT(*) FROM custom_products p WHERE p.category_id = c.id) as total_count
    FROM categories c
    ORDER BY c.sort_order ASC, c.id ASC
  `).all();
}

/**
 * Обновить название и/или порядок сортировки категории
 */
export function updateCategory(id, { name, sort_order }) {
  const category = getCategoryById(id);
  if (!category) return null;
  const nextName = name !== undefined ? String(name).trim() : category.name;
  const nextSort = sort_order !== undefined ? Number(sort_order) : category.sort_order;

  db.prepare(`
    UPDATE categories
    SET name = ?, sort_order = ?
    WHERE id = ?
  `).run(nextName, nextSort, Number(id));

  return getCategoryById(id);
}

/**
 * Удалить категорию (товары переходят в категорию без категории SET NULL)
 */
export function deleteCategory(id) {
  db.prepare(`UPDATE custom_products SET category_id = NULL WHERE category_id = ?`).run(Number(id));
  return db.prepare(`DELETE FROM categories WHERE id = ?`).run(Number(id));
}

/**
 * Привязать товар к категории (или отвязать при categoryId = null)
 */
export function updateProductCategory(productId, categoryId) {
  const targetCatId = categoryId ? Number(categoryId) : null;
  db.prepare(`
    UPDATE custom_products
    SET category_id = ?
    WHERE id = ?
  `).run(targetCatId, Number(productId));

  return getProductById(productId);
}

/**
 * Получить доступные товары по категории (или без категории при categoryId === null)
 * с поддержкой пагинации
 */
export function getAvailableProductsByCategory(categoryId = null, { page = 1, limit = 6 } = {}) {
  let products;
  if (categoryId === 'ALL' || categoryId === undefined || categoryId === false) {
    products = getAvailableProducts();
  } else if (categoryId === null || categoryId === 0 || categoryId === 'NONE') {
    products = db.prepare(`
      SELECT * FROM custom_products 
      WHERE is_hidden = 0 AND is_sold = 0 AND category_id IS NULL
      ORDER BY id DESC
    `).all().filter((p) => {
      if (p.product_type === 'FLEXIBLE') return true;
      if (p.is_unlimited) return true;
      return (p.stock - (p.reserved_stock || 0)) > 0;
    });
  } else {
    products = db.prepare(`
      SELECT * FROM custom_products 
      WHERE is_hidden = 0 AND is_sold = 0 AND category_id = ?
      ORDER BY id DESC
    `).all(Number(categoryId)).filter((p) => {
      if (p.product_type === 'FLEXIBLE') return true;
      if (p.is_unlimited) return true;
      return (p.stock - (p.reserved_stock || 0)) > 0;
    });
  }

  const total = products.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const offset = (currentPage - 1) * limit;
  const items = products.slice(offset, offset + limit);

  return {
    items,
    total,
    page: currentPage,
    totalPages,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
  };
}

/**
 * Полнотекстовый поиск товаров по названию и описанию:
 * SELECT * FROM custom_products
 * WHERE (name LIKE ? OR description LIKE ?)
 * AND (stock > 0 OR product_type = 'FLEXIBLE')
 */
export function searchAvailableProducts(queryText, { page = 1, limit = 6 } = {}) {
  const q = String(queryText || '').trim();
  if (!q) {
    return getAvailableProductsByCategory('ALL', { page, limit });
  }

  const pattern = `%${q}%`;
  const rows = db.prepare(`
    SELECT * FROM custom_products
    WHERE (name LIKE ? OR description LIKE ?)
      AND is_hidden = 0
      AND is_sold = 0
      AND (stock > 0 OR product_type = 'FLEXIBLE' OR is_unlimited = 1)
    ORDER BY id DESC
  `).all(pattern, pattern);

  const matched = rows.filter((p) => {
    if (p.product_type === 'FLEXIBLE') return true;
    if (p.is_unlimited) return true;
    return (p.stock - (p.reserved_stock || 0)) > 0;
  });

  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const offset = (currentPage - 1) * limit;
  const items = matched.slice(offset, offset + limit);

  return {
    items,
    total,
    page: currentPage,
    totalPages,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
    query: q,
  };
}

// ==========================================
// УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ (РЕГИСТРАЦИЯ И РАССЫЛКА)
// ==========================================

/**
 * Регистрация или обновление данных пользователя при /start
 */
export function registerUser(userId, username, firstName) {
  if (!userId) return null;
  const stmt = db.prepare(`
    INSERT INTO users (user_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      is_blocked = 0
  `);
  return stmt.run(userId, username || null, firstName || null);
}

/**
 * Получение всех активных пользователей для рассылки
 */
export function getAllActiveUsers() {
  return db.prepare('SELECT user_id, username, first_name FROM users WHERE is_blocked = 0').all();
}

/**
 * Получение общего количества зарегистрированных пользователей
 */
export function getUsersCount() {
  const row = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN is_blocked = 0 THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN is_blocked = 1 THEN 1 ELSE 0 END) as blocked
    FROM users
  `).get();
  return {
    total: row?.total || 0,
    active: row?.active || 0,
    blocked: row?.blocked || 0,
  };
}

/**
 * Пометка пользователя как заблокировавшего бота
 */
export function markUserBlocked(userId) {
  return db.prepare('UPDATE users SET is_blocked = 1 WHERE user_id = ?').run(userId);
}

/**
 * Пометка пользователя как активного
 */
export function markUserActive(userId) {
  return db.prepare('UPDATE users SET is_blocked = 0 WHERE user_id = ?').run(userId);
}

// Алиасы для обратной совместимости
export const getAvailableCustomProducts = getAvailableProducts;
export const getAllCustomProducts = getAllProducts;
export const getCustomProductById = getProductById;
export const markCustomProductSold = markProductSold;
export const deleteCustomProduct = deleteProduct;
export const createCustomProduct = createProduct;
export const setProductCategory = updateProductCategory;

export default {
  db,
  initDatabase,
  addColumnIfNotExists,
  safeAddColumn,
  parseMoney,
  formatMoney,
  getAvailableStock,
  createProduct,
  getAvailableProducts,
  getAllProducts,
  getProductById,
  updateProductName,
  updateProductDescription,
  updateProductPrice,
  updateProductMinAmount,
  updateProductMaxAmount,
  updateProductFee,
  updateProductAllowDecimals,
  updateProductEmoji,
  updateProductCurrency,
  updateProductExchangeRate,
  updateProductRequiresAvailabilityCheck,
  toggleProductRequiresAvailabilityCheck,
  toggleProductDeliveryType,
  toggleProductVisibility,
  replenishProductStock,
  deleteProduct,
  markProductSold,
  reserveProductStock,
  releaseProductReservation,
  createOrder,
  getOrderById,
  getActivePendingOrderByUser,
  updateOrderBuyerComment,
  attachReceipt,
  processProductDeliveryOnApproval,
  approveOrder,
  rejectOrder,
  refundOrder,
  getOrdersByUser,
  getAllOrders,
  getApprovedOrders,
  getDatabaseStats,
  findOrderByReceiptUniqueId,
  hasActivePendingOrder,
  getActiveOrder,
  resetUserPendingOrders,
  getUsersWithActiveOrders,
  cancelExpiredOrders,
  addToBlacklist,
  removeFromBlacklist,
  isBlacklisted,
  getAllBlacklisted,
  cancelOrder,
  updateOrderStatus,
  getAvailableCustomProducts,
  getAllCustomProducts,
  getCustomProductById,
  markCustomProductSold,
  deleteCustomProduct,
  createCustomProduct,
  createPromocode,
  getPromocodeById,
  getPromocodeByCode,
  getAllPromocodes,
  togglePromocodeActive,
  deletePromocode,
  hasUserUsedPromo,
  recordPromoUsage,
  validatePromocode,
  createCategory,
  getCategoryById,
  getAllCategories,
  updateCategory,
  deleteCategory,
  updateProductCategory,
  setProductCategory,
  getAvailableProductsByCategory,
  searchAvailableProducts,
  registerUser,
  getAllActiveUsers,
  getUsersCount,
  markUserBlocked,
  markUserActive,
};
