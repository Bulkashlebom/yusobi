import React, { useState, useEffect } from 'react';
import { 
  Bot, 
  Database, 
  CreditCard, 
  Package, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  Copy, 
  Check, 
  RefreshCw, 
  Plus, 
  Trash2, 
  Send, 
  FileCode2, 
  ShieldCheck, 
  ArrowRight,
  TrendingUp,
  MessageSquare,
  Sparkles,
  Zap,
  Edit3,
  RotateCcw,
  Eye,
  EyeOff,
  Key,
  Layers,
  FileText,
  Shield,
  ShieldAlert,
  UserX,
  Download,
  AlertTriangle
} from 'lucide-react';
import { SystemStatus, Order, CustomProduct, BlacklistItem } from './types';

export default function App() {
  const [activeTab, setActiveTab] = useState<'simulator' | 'orders' | 'custom_products' | 'security' | 'code'>('simulator');
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [customProducts, setCustomProducts] = useState<CustomProduct[]>([]);
  const [blacklist, setBlacklist] = useState<BlacklistItem[]>([]);
  const [newBanUserId, setNewBanUserId] = useState('');
  const [newBanReason, setNewBanReason] = useState('');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const formatMoney = (val: number | string | undefined): string => {
    const n = Number(val) || 0;
    return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
  };

  // Состояние создания своего товара
  const [newProduct, setNewProduct] = useState({
    name: '',
    description: '',
    price: '',
    delivery_type: 'AUTO' as 'AUTO' | 'MANUAL',
    secret_data: '',
    stock: '1',
    is_unlimited: false,
    product_type: 'FIXED' as 'FIXED' | 'FLEXIBLE',
    min_amount: '100',
    max_amount: '100000',
    fee_percent: '0',
  });
  const [isSubmittingProduct, setIsSubmittingProduct] = useState(false);

  // Модальные окна управления лотом
  const [editDetailsModal, setEditDetailsModal] = useState<{
    product: CustomProduct;
    name: string;
    description: string;
  } | null>(null);

  const [editPriceModal, setEditPriceModal] = useState<{ product: CustomProduct; price: string } | null>(null);

  const [editFlexibleModal, setEditFlexibleModal] = useState<{
    product: CustomProduct;
    min_amount: string;
    max_amount: string;
    fee_percent: string;
  } | null>(null);

  const [replenishModal, setReplenishModal] = useState<{
    product: CustomProduct;
    additionalKeys: string;
    addStock: string;
    setUnlimited: boolean;
  } | null>(null);

  // Состояния для диалогов заказов (подтверждение, отклонение, возврат)
  const [activeOrderAction, setActiveOrderAction] = useState<{
    order: Order;
    type: 'approve' | 'reject';
    comment: string;
  } | null>(null);

  const [refundModal, setRefundModal] = useState<{
    order: Order;
    restock: boolean;
  } | null>(null);

  const [viewKeysModal, setViewKeysModal] = useState<{
    order: Order;
  } | null>(null);

  // Состояние симулятора Telegram-бота
  const [chatMessages, setChatMessages] = useState<Array<{
    sender: 'bot' | 'user';
    text: string;
    keyboard?: any[];
    order?: Order;
    product?: CustomProduct;
    products?: CustomProduct[];
  }>>([
    {
      sender: 'bot',
      text: '👋 <b>Добро пожаловать в наш магазин цифровых товаров!</b>\n\nЗдесь вы можете приобрести проверенные цифровые товары, ключи, подписки и готовые аккаунты с гарантией.\n\n⚡ <b>Автовыдача</b> — моментальная доставка сразу после проверки чека\n✍️ <b>Ручная выдача</b> — индивидуальное оформление и настройка администратором\n\nВыберите раздел в меню ниже 👇',
      keyboard: [
        [{ label: '📦 Каталог товаров', action: 'catalog' }],
        [{ label: '🛍 Мои покупки', action: 'my_orders' }, { label: '💬 Поддержка', action: 'support' }],
        [{ label: '👑 Панель администратора', action: 'admin' }],
      ],
    },
  ]);
  const [customCommentInput, setCustomCommentInput] = useState('');
  const [simActiveOrderId, setSimActiveOrderId] = useState<number | null>(null);

  // Выбранный файл для просмотра кода
  const [selectedFile, setSelectedFile] = useState<string>('bot.js');
  const [fileContent, setFileContent] = useState<string>('');
  const [isLoadingFile, setIsLoadingFile] = useState<boolean>(false);

  // Загрузка первичных данных
  const fetchAllData = async () => {
    try {
      setIsLoading(true);
      const [statusRes, ordersRes, customRes, blacklistRes] = await Promise.all([
        fetch('/api/system/status'),
        fetch('/api/orders'),
        fetch('/api/custom-products'),
        fetch('/api/blacklist'),
      ]);

      if (statusRes.ok) setStatus(await statusRes.json());
      if (ordersRes.ok) {
        const data = await ordersRes.json();
        setOrders(data.orders || []);
      }
      if (customRes.ok) {
        const data = await customRes.json();
        setCustomProducts(data.products || []);
      }
      if (blacklistRes.ok) {
        const data = await blacklistRes.json();
        setBlacklist(data.blacklist || []);
      }
    } catch (err) {
      console.error('Ошибка загрузки данных:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAllData();
  }, []);

  // Загрузка файлов кода
  const fetchFile = async (filename: string) => {
    try {
      setIsLoadingFile(true);
      setSelectedFile(filename);
      const res = await fetch(`/api/files/${filename}`);
      if (res.ok) {
        const data = await res.json();
        setFileContent(data.content || '');
      } else {
        setFileContent('// Ошибка чтения файла');
      }
    } catch (e) {
      setFileContent('// Ошибка соединения');
    } finally {
      setIsLoadingFile(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'code') {
      fetchFile(selectedFile);
    }
  }, [activeTab]);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(id);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // Добавление товара
  const handleCreateProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProduct.name) {
      alert('Укажите название товара');
      return;
    }

    const isFlex = newProduct.product_type === 'FLEXIBLE';

    if (!isFlex && (!newProduct.price || Number(newProduct.price) <= 0)) {
      alert('Укажите корректную цену товара');
      return;
    }

    if (!isFlex && newProduct.delivery_type === 'AUTO' && !newProduct.secret_data) {
      alert('Укажите ключи для авто-выдачи!');
      return;
    }

    if (isFlex && (Number(newProduct.min_amount) < 0 || Number(newProduct.max_amount) <= 0 || Number(newProduct.min_amount) > Number(newProduct.max_amount))) {
      alert('Укажите корректный диапазон сумм (мин <= макс)');
      return;
    }

    try {
      setIsSubmittingProduct(true);
      const res = await fetch('/api/custom-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...newProduct,
          price: isFlex ? 0 : Number(newProduct.price),
          min_amount: isFlex ? Number(newProduct.min_amount) : 0,
          max_amount: isFlex ? Number(newProduct.max_amount) : 0,
          fee_percent: isFlex ? Number(newProduct.fee_percent) : 0,
          stock: !isFlex && newProduct.delivery_type === 'MANUAL' ? (newProduct.is_unlimited ? 999999 : Number(newProduct.stock) || 1) : undefined,
          is_unlimited: isFlex ? 1 : newProduct.delivery_type === 'MANUAL' && newProduct.is_unlimited ? 1 : 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка добавления');

      setNewProduct({
        name: '',
        description: '',
        price: '',
        delivery_type: 'AUTO',
        secret_data: '',
        stock: '1',
        is_unlimited: false,
        product_type: 'FIXED',
        min_amount: '100',
        max_amount: '100000',
        fee_percent: '0',
      });
      fetchAllData();
    } catch (err: any) {
      alert(`Ошибка: ${err.message}`);
    } finally {
      setIsSubmittingProduct(false);
    }
  };

  // Обновление параметров пополнения (FLEXIBLE)
  const handleUpdateFlexible = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editFlexibleModal) return;

    const minNum = Number(editFlexibleModal.min_amount);
    const maxNum = Number(editFlexibleModal.max_amount);
    const feeNum = Number(editFlexibleModal.fee_percent);

    if (minNum < 0 || maxNum <= 0 || minNum > maxNum) {
      alert('Проверьте диапазон сумм (минимум должен быть меньше или равен максимуму)');
      return;
    }
    if (feeNum < 0) {
      alert('Комиссия не может быть отрицательной');
      return;
    }

    try {
      await Promise.all([
        fetch(`/api/custom-products/${editFlexibleModal.product.id}/min-amount`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ min_amount: minNum }),
        }),
        fetch(`/api/custom-products/${editFlexibleModal.product.id}/max-amount`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ max_amount: maxNum }),
        }),
        fetch(`/api/custom-products/${editFlexibleModal.product.id}/fee-percent`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fee_percent: feeNum }),
        }),
      ]);

      setEditFlexibleModal(null);
      fetchAllData();
    } catch (err: any) {
      alert(`Ошибка: ${err.message}`);
    }
  };

  // Обновление названия и описания товара
  const handleUpdateProductDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editDetailsModal) return;

    try {
      await fetch(`/api/custom-products/${editDetailsModal.product.id}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editDetailsModal.name }),
      });
      await fetch(`/api/custom-products/${editDetailsModal.product.id}/description`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: editDetailsModal.description }),
      });

      setEditDetailsModal(null);
      fetchAllData();
    } catch (err: any) {
      alert(`Ошибка: ${err.message}`);
    }
  };

  // Обновление цены
  const handleUpdatePrice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editPriceModal) return;
    const priceNum = Number(editPriceModal.price);
    if (isNaN(priceNum) || priceNum <= 0) {
      alert('Введите корректную положительную цену');
      return;
    }

    try {
      const res = await fetch(`/api/custom-products/${editPriceModal.product.id}/price`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ price: priceNum }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Ошибка обновления цены');
      }
      setEditPriceModal(null);
      fetchAllData();
    } catch (err: any) {
      alert(`Ошибка: ${err.message}`);
    }
  };

  // Переключение типа доставки в 1 клик (AUTO <-> MANUAL)
  const handleToggleDeliveryType = async (id: number) => {
    try {
      const res = await fetch(`/api/custom-products/${id}/toggle-type`, { method: 'POST' });
      if (res.ok) fetchAllData();
    } catch (e) {
      console.error(e);
    }
  };

  // Переключение видимости в 1 клик (Скрыть / Показать)
  const handleToggleVisibility = async (id: number) => {
    try {
      const res = await fetch(`/api/custom-products/${id}/toggle-visibility`, { method: 'POST' });
      if (res.ok) fetchAllData();
    } catch (e) {
      console.error(e);
    }
  };

  // Пополнение остатка / ключей
  const handleReplenishStock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replenishModal) return;

    try {
      const res = await fetch(`/api/custom-products/${replenishModal.product.id}/replenish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          additionalKeys: replenishModal.additionalKeys,
          addStock: Number(replenishModal.addStock) || 0,
          setUnlimited: replenishModal.setUnlimited,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Ошибка пополнения');
      }
      setReplenishModal(null);
      fetchAllData();
    } catch (err: any) {
      alert(`Ошибка: ${err.message}`);
    }
  };

  // Удаление товара
  const handleDeleteProduct = async (id: number) => {
    if (!confirm('Вы уверены, что хотите удалить этот товар?')) return;
    try {
      const res = await fetch(`/api/custom-products/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchAllData();
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Подтверждение заказа
  const handleApproveOrder = async (orderId: number, comment: string) => {
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment }),
      });
      if (res.ok) {
        setActiveOrderAction(null);
        fetchAllData();
      } else {
        const err = await res.json();
        alert(`Ошибка: ${err.error}`);
      }
    } catch (e: any) {
      alert(e.message);
    }
  };

  // Отклонение заказа
  const handleRejectOrder = async (orderId: number, reason: string) => {
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (res.ok) {
        setActiveOrderAction(null);
        fetchAllData();
      } else {
        const err = await res.json();
        alert(`Ошибка: ${err.error}`);
      }
    } catch (e: any) {
      alert(e.message);
    }
  };

  // Оформление возврата (REFUND)
  const handleRefundOrder = async () => {
    if (!refundModal) return;
    try {
      const res = await fetch(`/api/admin/orders/${refundModal.order.id}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restock: refundModal.restock }),
      });
      if (res.ok) {
        setRefundModal(null);
        fetchAllData();
      } else {
        const err = await res.json();
        alert(`Ошибка: ${err.error}`);
      }
    } catch (e: any) {
      alert(e.message);
    }
  };

  // Мгновенная блокировка пользователя из заказа (кнопка "В бан")
  const handleBanOrderUser = async (order: Order) => {
    if (!confirm(`Заблокировать пользователя ID: ${order.user_id} и аннулировать заказ #${order.id}?`)) return;
    try {
      const res = await fetch(`/api/admin/orders/${order.id}/ban`, { method: 'POST' });
      if (res.ok) {
        alert(`Пользователь ID: ${order.user_id} заблокирован! Заказ #${order.id} отменен.`);
        fetchAllData();
      } else {
        const err = await res.json();
        alert(`Ошибка: ${err.error}`);
      }
    } catch (e: any) {
      alert(e.message);
    }
  };

  // Разблокировка пользователя
  const handleUnbanUser = async (userId: number) => {
    try {
      const res = await fetch('/api/blacklist/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        fetchAllData();
      } else {
        const err = await res.json();
        alert(`Ошибка: ${err.error}`);
      }
    } catch (e: any) {
      alert(e.message);
    }
  };

  // Ручное добавление в черный список
  const handleManualBan = async (e: React.FormEvent) => {
    e.preventDefault();
    const uid = Number(newBanUserId.trim());
    if (!uid) {
      alert('Укажите корректный числовой Telegram ID пользователя');
      return;
    }
    try {
      const res = await fetch('/api/blacklist/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: uid, reason: newBanReason.trim() || 'Ручная блокировка' }),
      });
      if (res.ok) {
        setNewBanUserId('');
        setNewBanReason('');
        fetchAllData();
      } else {
        const err = await res.json();
        alert(`Ошибка: ${err.error}`);
      }
    } catch (e: any) {
      alert(e.message);
    }
  };

  // Отправка команды в веб-симулятор
  const handleSimulateAction = async (action: string, payload?: any) => {
    setChatMessages((prev) => [
      ...prev,
      { sender: 'user', text: payload?.label || action },
    ]);

    try {
      const res = await fetch('/api/bot/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      });
      const data = await res.json();

      if (data.order?.id) {
        setSimActiveOrderId(data.order.id);
      }

      setChatMessages((prev) => [
        ...prev,
        {
          sender: 'bot',
          text: data.text,
          keyboard: data.keyboard,
          order: data.order,
          product: data.product,
          products: data.products,
        },
      ]);

      fetchAllData();
    } catch (e) {
      setChatMessages((prev) => [
        ...prev,
        { sender: 'bot', text: '⚠️ Ошибка обработки действия симулятора' },
      ]);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col font-sans">
      {/* Шапка приложения */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-xs">
              <Bot className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold text-slate-900 leading-tight">Telegram Digital Shop</h1>
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
                  SQLite (better-sqlite3)
                </span>
              </div>
              <p className="text-xs text-slate-500">Автономный магазин с учетом количества, бронью и системой возвратов</p>
            </div>
          </div>

          {/* Быстрая сводка */}
          <div className="hidden md:flex items-center gap-6">
            <div className="text-right">
              <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider block">Выручка магазина</span>
              <span className="text-sm font-bold text-emerald-600">
                {status?.database.totalRevenue ? Number(status.database.totalRevenue).toLocaleString('ru-RU') : 0} ₽
              </span>
            </div>
            <div className="h-7 w-px bg-slate-200" />
            <a
              href="/api/backup"
              download
              title="Скачать резервную копию базы данных shop.db"
              className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-blue-600" />
              Бэкап БД
            </a>
            <button
              onClick={fetchAllData}
              disabled={isLoading}
              title="Обновить данные"
              className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 transition cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Вкладки навигации */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex gap-1 border-t border-slate-100 overflow-x-auto">
          <button
            onClick={() => setActiveTab('simulator')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'simulator'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Bot className="w-4 h-4" />
            Симулятор Telegram-бота
          </button>
          <button
            onClick={() => setActiveTab('orders')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'orders'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <CreditCard className="w-4 h-4" />
            Заказы и чеки
            {status && status.database.pendingOrders > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-amber-500 text-white text-[10px] font-bold">
                {status.database.pendingOrders}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('custom_products')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'custom_products'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Package className="w-4 h-4" />
            Управление товарами
            <span className="px-1.5 py-0.2 rounded-full bg-slate-200 text-slate-700 text-[10px]">
              {customProducts.length}
            </span>
          </button>
          <button
            onClick={() => setActiveTab('security')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'security'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Shield className="w-4 h-4" />
            Безопасность (Anti-Fraud)
            {blacklist.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-red-100 text-red-700 text-[10px] font-bold">
                {blacklist.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('code')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'code'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <FileCode2 className="w-4 h-4" />
            Код проекта (bot.js, db.js)
          </button>
        </div>
      </header>

      {/* Основной контент */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 w-full flex-1">
        
        {/* ВКЛАДКА: СИМУЛЯТОР TELEGRAM БОТА */}
        {activeTab === 'simulator' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Окно смартфона с Telegram чатом */}
            <div className="lg:col-span-7 bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col h-[700px] overflow-hidden">
              {/* Верхняя панель смартфона */}
              <div className="bg-slate-900 text-white p-3.5 flex items-center justify-between shadow-xs">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center font-bold text-sm">
                    🤖
                  </div>
                  <div>
                    <h2 className="text-xs font-bold leading-tight">Digital Shop Bot</h2>
                    <span className="text-[10px] text-emerald-400 block">онлайн • бот магазина</span>
                  </div>
                </div>
                <button
                  onClick={() => handleSimulateAction('start')}
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] font-medium transition cursor-pointer"
                >
                  /start
                </button>
              </div>

              {/* Область сообщений */}
              <div className="flex-1 p-4 overflow-y-auto space-y-3.5 bg-slate-100/70">
                {chatMessages.map((msg, idx) => (
                  <div
                    key={idx}
                    className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl p-3.5 text-xs shadow-xs leading-relaxed ${
                        msg.sender === 'user'
                          ? 'bg-blue-600 text-white rounded-br-xs'
                          : 'bg-white text-slate-800 border border-slate-200/80 rounded-bl-xs'
                      }`}
                    >
                      <div
                        dangerouslySetInnerHTML={{ __html: msg.text.replace(/\n/g, '<br/>') }}
                        className="prose prose-xs max-w-none [&_b]:font-bold [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[11px] [&_pre]:bg-slate-900 [&_pre]:text-emerald-400 [&_pre]:p-2.5 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:font-mono [&_pre]:text-[11px] [&_pre]:my-1.5"
                      />

                      {/* Инлайн кнопки Telegram-бота */}
                      {msg.keyboard && msg.keyboard.length > 0 && (
                        <div className="mt-3 pt-2.5 border-t border-slate-100 space-y-1.5">
                          {msg.keyboard.map((row: any[], rIdx: number) => (
                            <div key={rIdx} className="flex gap-1.5">
                              {row.map((btn: any, bIdx: number) => (
                                <button
                                  key={bIdx}
                                  onClick={() => handleSimulateAction(btn.action, btn.payload)}
                                  className="flex-1 py-1.5 px-2.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg font-medium text-[11px] transition text-center cursor-pointer border border-blue-200/60"
                                >
                                  {btn.label}
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Нижнее поле ввода симулятора */}
              <div className="p-3 bg-white border-t border-slate-200 flex gap-2">
                <input
                  type="text"
                  placeholder="Отправьте комментарий или количество..."
                  value={customCommentInput}
                  onChange={(e) => setCustomCommentInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && customCommentInput.trim()) {
                      if (simActiveOrderId) {
                        handleSimulateAction(`send_comment_${simActiveOrderId}`, { comment: customCommentInput });
                      } else {
                        handleSimulateAction('text_message', { label: customCommentInput });
                      }
                      setCustomCommentInput('');
                    }
                  }}
                  className="flex-1 px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={() => {
                    if (!customCommentInput.trim()) return;
                    if (simActiveOrderId) {
                      handleSimulateAction(`send_comment_${simActiveOrderId}`, { comment: customCommentInput });
                    } else {
                      handleSimulateAction('text_message', { label: customCommentInput });
                    }
                    setCustomCommentInput('');
                  }}
                  className="p-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition cursor-pointer"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Правая колонка с описанием функций и статусом */}
            <div className="lg:col-span-5 space-y-4">
              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-3">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-amber-500" />
                  Новые возможности магазина
                </h3>
                <ul className="text-xs text-slate-600 space-y-2 list-disc pl-4 leading-relaxed">
                  <li>
                    <b>Покупка нескольких штук (QTY):</b> выбор кнопками [-] / [+] или ввод точного числа. Сумма пересчитывается автоматически.
                  </li>
                  <li>
                    <b>Резервация товара:</b> на время оплаты лот бронируется, исключая повторную покупку другими клиентами.
                  </li>
                  <li>
                    <b>Выдача ровно qty ключей:</b> автовыдача отрезает верхние qty ключей из таблицы и сохраняет их в заказе.
                  </li>
                  <li>
                    <b>Система возвратов (REFUND):</b> администратор может оформить возврат с возвратом ключей в наличие или списанием.
                  </li>
                  <li>
                    <b>«🛍 Мои покупки»:</b> покупатель в любой момент может открыть бота и скопировать выданные ключи.
                  </li>
                </ul>
              </div>

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-3">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  Параметры бота
                </h3>
                <div className="space-y-2 text-xs">
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-between">
                    <span className="text-slate-500">BOT_TOKEN:</span>
                    <span className="font-mono font-semibold text-slate-800">
                      {status?.bot.hasToken ? status.bot.tokenMasked : '⚠️ Не указан (демо-режим)'}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-between">
                    <span className="text-slate-500">ADMIN_ID:</span>
                    <span className="font-mono font-semibold text-slate-800">{status?.bot.adminId}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="text-slate-400 block text-[10px]">SUPPORT_CONTACT</span>
                    <span className="font-bold text-blue-600">{status?.bot.supportContact}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ВКЛАДКА: ЗАКАЗЫ И ЧЕКИ */}
        {activeTab === 'orders' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-slate-900">Заказы покупателей</h2>
                <p className="text-xs text-slate-500">
                  Все заказы хранятся в таблице orders SQLite (подтверждение, отклонение, возврат)
                </p>
              </div>
              <span className="text-xs font-semibold px-2.5 py-1 bg-blue-50 text-blue-700 rounded-lg border border-blue-200">
                Всего заказов: {orders.length}
              </span>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500 uppercase text-[10px] font-semibold border-b border-slate-200">
                    <tr>
                      <th className="py-3.5 px-4"># ID</th>
                      <th className="py-3.5 px-4">Покупатель</th>
                      <th className="py-3.5 px-4">Товар</th>
                      <th className="py-3.5 px-4">Кол-во</th>
                      <th className="py-3.5 px-4">Сумма</th>
                      <th className="py-3.5 px-4">Чек</th>
                      <th className="py-3.5 px-4">Статус</th>
                      <th className="py-3.5 px-4 text-right">Действия</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {orders.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-8 text-center text-slate-400">
                          Заказов пока нет. Оформите заказ в симуляторе бота!
                        </td>
                      </tr>
                    ) : (
                      orders.map((ord) => (
                        <tr key={ord.id} className="hover:bg-slate-50/80 transition">
                          <td className="py-3.5 px-4 font-mono font-bold text-slate-900">#{ord.id}</td>
                          <td className="py-3.5 px-4">
                            <span className="font-semibold text-slate-800 block">@{ord.username || 'client'}</span>
                            <span className="text-[10px] text-slate-400 font-mono">ID: {ord.user_id}</span>
                          </td>
                          <td className="py-3.5 px-4">
                            <span className="font-medium text-slate-800 block">{ord.product_name || `Товар #${ord.product_id}`}</span>
                            <div className="text-[10px] text-slate-400 font-mono flex flex-col">
                              <span>
                                {ord.product_type === 'FLEXIBLE'
                                  ? '💳 Пополнение'
                                  : ord.product_delivery_type === 'MANUAL'
                                  ? '✍️ Ручная'
                                  : '⚡ Авто'}
                              </span>
                              {ord.base_amount ? (
                                <span className="text-blue-600">
                                  Зачисление: {formatMoney(ord.base_amount)}
                                  {ord.fee_amount ? ` (+${ord.fee_percent}%)` : ''}
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td className="py-3.5 px-4 font-bold text-slate-700">
                            {ord.product_type === 'FLEXIBLE' ? '1 услуга' : `${ord.quantity || 1} шт.`}
                          </td>
                          <td className="py-3.5 px-4 font-bold text-slate-900">{formatMoney(ord.amount)}</td>
                          <td className="py-3.5 px-4">
                            {ord.receipt_file_id ? (
                              <div className="flex flex-col gap-0.5">
                                <span className="px-2 py-0.5 rounded text-[10px] bg-blue-50 text-blue-700 border border-blue-200 font-mono">
                                  📸 Чек получен
                                </span>
                                {ord.receipt_unique_id && (
                                  <span
                                    className="text-[9px] font-mono text-slate-500 truncate max-w-[120px]"
                                    title={`file_unique_id: ${ord.receipt_unique_id}`}
                                  >
                                    🔑 {ord.receipt_unique_id.slice(0, 10)}...
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-slate-400 text-[11px]">Ожидается</span>
                            )}
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="flex flex-col gap-1 items-start">
                              {ord.status === 'APPROVED' && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">
                                  ✅ Подтвержден
                                </span>
                              )}
                              {ord.status === 'REJECTED' && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-800">
                                  ❌ Отклонен
                                </span>
                              )}
                              {ord.status === 'PENDING' && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800">
                                  ⏳ Ожидает проверки
                                </span>
                              )}
                              {ord.status === 'REFUNDED' && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-800">
                                  🔄 Возврат (Refund)
                                </span>
                              )}
                              {Boolean(ord.is_reserved) && (
                                <span className="px-1.5 py-0.2 rounded text-[9px] bg-indigo-50 text-indigo-700 border border-indigo-200">
                                  🔒 В брони
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-3.5 px-4 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              {ord.delivered_keys && (
                                <button
                                  onClick={() => setViewKeysModal({ order: ord })}
                                  className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium text-[11px] transition cursor-pointer flex items-center gap-1"
                                  title="Посмотреть выданные ключи"
                                >
                                  <Key className="w-3 h-3 text-amber-600" />
                                  Ключи
                                </button>
                              )}

                              {ord.status === 'PENDING' && (
                                <>
                                  <button
                                    onClick={() => setActiveOrderAction({ order: ord, type: 'approve', comment: '' })}
                                    className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-[11px] transition cursor-pointer"
                                  >
                                    Подтвердить
                                  </button>
                                  <button
                                    onClick={() => setActiveOrderAction({ order: ord, type: 'reject', comment: '' })}
                                    className="px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-medium text-[11px] transition cursor-pointer"
                                  >
                                    Отклонить
                                  </button>
                                  <button
                                    onClick={() => handleBanOrderUser(ord)}
                                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-900 text-white font-medium text-[11px] transition cursor-pointer flex items-center gap-1"
                                    title="Заблокировать пользователя и аннулировать заказ"
                                  >
                                    <UserX className="w-3 h-3 text-red-400" />
                                    В бан
                                  </button>
                                </>
                              )}

                              {ord.status === 'APPROVED' && (
                                <button
                                  onClick={() => setRefundModal({ order: ord, restock: true })}
                                  className="px-2 py-1 rounded bg-purple-50 hover:bg-purple-100 text-purple-700 font-medium text-[11px] transition cursor-pointer flex items-center gap-1"
                                  title="Оформить возврат"
                                >
                                  <RotateCcw className="w-3 h-3" />
                                  Возврат
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ВКЛАДКА: КАТАЛОГ ТОВАРОВ АДМИНИСТРАТОРА */}
        {activeTab === 'custom_products' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Список товаров */}
            <div className="lg:col-span-8 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-slate-900">Управление лотами магазина</h2>
                  <p className="text-xs text-slate-500">
                    Полное редактирование, 1-клик переключение типов, скрытие и пополнение
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {customProducts.map((p) => {
                  const isFlex = p.product_type === 'FLEXIBLE';
                  const isSoldOut = !isFlex && Boolean(p.is_sold || (!p.is_unlimited && p.stock <= 0));
                  return (
                    <div
                      key={p.id}
                      className={`bg-white rounded-2xl border p-4 shadow-sm flex flex-col justify-between transition ${
                        p.is_hidden
                          ? 'border-amber-200 bg-amber-50/20'
                          : isSoldOut
                          ? 'border-slate-200 opacity-75 bg-slate-50/50'
                          : isFlex
                          ? 'border-blue-100 hover:border-blue-300'
                          : 'border-slate-200 hover:border-blue-200'
                      }`}
                    >
                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="text-xs font-bold text-slate-900 leading-snug">{p.name}</h3>
                          <div className="flex items-center gap-1 shrink-0">
                            {/* Тип товара */}
                            {isFlex ? (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                                💳 Пополнение
                              </span>
                            ) : (
                              <button
                                onClick={() => handleToggleDeliveryType(p.id)}
                                className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition cursor-pointer hover:opacity-80 ${
                                  p.delivery_type === 'MANUAL'
                                    ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                    : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                }`}
                                title="Нажмите, чтобы переключить тип доставки"
                              >
                                {p.delivery_type === 'MANUAL' ? '✍️ Ручная' : '⚡ Авто'}
                              </button>
                            )}

                            {/* 1-клик скрытие с витрины */}
                            <button
                              onClick={() => handleToggleVisibility(p.id)}
                              className={`p-1 rounded text-[10px] transition cursor-pointer hover:bg-slate-100 ${
                                p.is_hidden ? 'text-amber-600' : 'text-slate-400'
                              }`}
                              title={p.is_hidden ? 'Лот скрыт. Нажмите, чтобы опубликовать' : 'Нажмите, чтобы скрыть с витрины'}
                            >
                              {p.is_hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        </div>

                        <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                          {p.description || 'Без описания'}
                        </p>

                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                          {isFlex ? (
                            <>
                              <span className="px-2 py-0.5 rounded-md bg-blue-50 text-blue-800 font-mono font-medium border border-blue-100">
                                Диапазон: {formatMoney(p.min_amount)} – {formatMoney(p.max_amount)}
                              </span>
                              <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-800 font-mono font-medium border border-emerald-100">
                                Комиссия: +{p.fee_percent || 0}%
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-mono font-medium">
                                {p.is_unlimited ? '♾️ Бесконечный (много)' : `📦 Остаток: ${p.stock} шт.`}
                              </span>

                              {Boolean(p.reserved_stock && p.reserved_stock > 0) && (
                                <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px]">
                                  🔒 В брони: {p.reserved_stock} шт.
                                </span>
                              )}
                            </>
                          )}

                          {p.is_hidden ? (
                            <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold">
                              🙈 Скрыт
                            </span>
                          ) : isSoldOut ? (
                            <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-semibold">
                              🔴 Закончился
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-semibold">
                              🟢 На витрине
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
                        <div>
                          {isFlex ? (
                            <div>
                              <span className="text-sm font-bold text-slate-900">от {formatMoney(p.min_amount)}</span>
                              <span className="text-[10px] text-slate-400 block font-normal">гибкая сумма</span>
                            </div>
                          ) : (
                            <span className="text-sm font-bold text-slate-900">{formatMoney(p.price)}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setEditDetailsModal({ product: p, name: p.name, description: p.description || '' })}
                            className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-100 transition cursor-pointer"
                            title="Изменить название и описание"
                          >
                            <FileText className="w-3.5 h-3.5" />
                          </button>

                          {isFlex ? (
                            <button
                              onClick={() => setEditFlexibleModal({
                                product: p,
                                min_amount: String(p.min_amount || 0),
                                max_amount: String(p.max_amount || 0),
                                fee_percent: String(p.fee_percent || 0),
                              })}
                              className="px-2 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 text-[11px] font-semibold transition cursor-pointer flex items-center gap-1"
                              title="Настроить диапазон сумм и комиссию"
                            >
                              <Edit3 className="w-3 h-3" />
                              Лимиты
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={() => setEditPriceModal({ product: p, price: String(p.price) })}
                                className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-100 transition cursor-pointer"
                                title="Изменить цену"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => setReplenishModal({
                                  product: p,
                                  additionalKeys: '',
                                  addStock: '1',
                                  setUnlimited: Boolean(p.is_unlimited),
                                })}
                                className="px-2 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 text-[11px] font-semibold transition cursor-pointer flex items-center gap-1"
                                title="Пополнить товар"
                              >
                                <Plus className="w-3 h-3" />
                                Пополнить
                              </button>
                            </>
                          )}

                          <button
                            onClick={() => handleDeleteProduct(p.id)}
                            className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 transition cursor-pointer"
                            title="Удалить товар"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Форма добавления нового товара */}
            <div className="lg:col-span-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2 mb-3">
                <Plus className="w-4 h-4 text-blue-600" />
                Добавить новый товар
              </h3>

              <form onSubmit={handleCreateProduct} className="space-y-3 text-xs">
                {/* Выбор типа товара */}
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Тип товара / услуги *</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setNewProduct({ ...newProduct, product_type: 'FIXED' })}
                      className={`p-2 rounded-lg border text-center transition cursor-pointer text-xs ${
                        newProduct.product_type === 'FIXED'
                          ? 'border-blue-600 bg-blue-50 text-blue-700 font-semibold'
                          : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      📦 Штучный товар
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewProduct({ ...newProduct, product_type: 'FLEXIBLE' })}
                      className={`p-2 rounded-lg border text-center transition cursor-pointer text-xs ${
                        newProduct.product_type === 'FLEXIBLE'
                          ? 'border-blue-600 bg-blue-50 text-blue-700 font-semibold'
                          : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      💳 Пополнение (гибкая)
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block font-medium text-slate-700 mb-1">Название товара *</label>
                  <input
                    type="text"
                    required
                    placeholder={
                      newProduct.product_type === 'FLEXIBLE'
                        ? 'Например: Пополнение Steam / Баланс'
                        : 'Например: Telegram Stars (100 шт.)'
                    }
                    value={newProduct.name}
                    onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block font-medium text-slate-700 mb-1">Описание лота</label>
                  <textarea
                    rows={2}
                    placeholder="Условия, инструкция и гарантия"
                    value={newProduct.description}
                    onChange={(e) => setNewProduct({ ...newProduct, description: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500"
                  />
                </div>

                {newProduct.product_type === 'FLEXIBLE' ? (
                  <div className="space-y-2 p-3 bg-blue-50/50 rounded-xl border border-blue-100">
                    <span className="font-semibold text-blue-900 block text-[11px]">Параметры пополнения</span>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] font-medium text-slate-600 mb-0.5">Мин. сумма (₽):</label>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          required
                          value={newProduct.min_amount}
                          onChange={(e) => setNewProduct({ ...newProduct, min_amount: e.target.value })}
                          className="w-full px-2.5 py-1.5 bg-white rounded-lg border border-slate-200"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-medium text-slate-600 mb-0.5">Макс. сумма (₽):</label>
                        <input
                          type="number"
                          min={1}
                          step="0.01"
                          required
                          value={newProduct.max_amount}
                          onChange={(e) => setNewProduct({ ...newProduct, max_amount: e.target.value })}
                          className="w-full px-2.5 py-1.5 bg-white rounded-lg border border-slate-200"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-slate-600 mb-0.5">Комиссия сервиса (%):</label>
                      <input
                        type="number"
                        min={0}
                        step="0.1"
                        placeholder="Например: 5"
                        value={newProduct.fee_percent}
                        onChange={(e) => setNewProduct({ ...newProduct, fee_percent: e.target.value })}
                        className="w-full px-2.5 py-1.5 bg-white rounded-lg border border-slate-200"
                      />
                      <p className="text-[10px] text-slate-400 mt-1">
                        Наценка к сумме пополнения (0 = без наценки).
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Цена в рублях (поддержка 10.50) *</label>
                      <input
                        type="number"
                        required
                        step="0.01"
                        min={0.01}
                        placeholder="499.99"
                        value={newProduct.price}
                        onChange={(e) => setNewProduct({ ...newProduct, price: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500 font-bold"
                      />
                    </div>

                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Способ доставки *</label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setNewProduct({ ...newProduct, delivery_type: 'AUTO' })}
                          className={`p-2 rounded-lg border text-center transition cursor-pointer text-xs ${
                            newProduct.delivery_type === 'AUTO'
                              ? 'border-blue-600 bg-blue-50 text-blue-700 font-semibold'
                              : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          ⚡ Авто-выдача
                        </button>
                        <button
                          type="button"
                          onClick={() => setNewProduct({ ...newProduct, delivery_type: 'MANUAL' })}
                          className={`p-2 rounded-lg border text-center transition cursor-pointer text-xs ${
                            newProduct.delivery_type === 'MANUAL'
                              ? 'border-blue-600 bg-blue-50 text-blue-700 font-semibold'
                              : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          ✍️ Ручная выдача
                        </button>
                      </div>
                    </div>

                    {newProduct.delivery_type === 'AUTO' ? (
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">
                          Данные / ключи автовыдачи (каждый с новой строки) *
                        </label>
                        <textarea
                          rows={4}
                          required
                          placeholder={"KEY-XXXX-1111\nKEY-YYYY-2222\nKEY-ZZZZ-3333"}
                          value={newProduct.secret_data}
                          onChange={(e) => setNewProduct({ ...newProduct, secret_data: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500 font-mono text-[11px]"
                        />
                        <p className="text-[10px] text-slate-400 mt-1">
                          💡 Количество на складе (stock) определится автоматически по числу строк с ключами.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2 p-3 bg-slate-50 rounded-xl border border-slate-200">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-slate-700">Бесконечный лот (inf)?</span>
                          <input
                            type="checkbox"
                            checked={newProduct.is_unlimited}
                            onChange={(e) => setNewProduct({ ...newProduct, is_unlimited: e.target.checked })}
                            className="w-4 h-4 text-blue-600 rounded cursor-pointer"
                          />
                        </div>
                        {!newProduct.is_unlimited && (
                          <div>
                            <label className="block text-[11px] text-slate-600 mb-1">Доступное количество (stock):</label>
                            <input
                              type="number"
                              min={1}
                              value={newProduct.stock}
                              onChange={(e) => setNewProduct({ ...newProduct, stock: e.target.value })}
                              className="w-full px-2.5 py-1.5 bg-white rounded-lg border border-slate-200"
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}

                <button
                  type="submit"
                  disabled={isSubmittingProduct}
                  className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition cursor-pointer shadow-xs disabled:opacity-50"
                >
                  {isSubmittingProduct ? 'Создание...' : 'Опубликовать товар'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* ВКЛАДКА: БЕЗОПАСНОСТЬ И АНТИФРОД */}
        {activeTab === 'security' && (
          <div className="space-y-6">
            {/* Карточки архитектуры безопасности */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-2">
                <div className="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <h4 className="text-xs font-bold text-slate-900">Защита от повторных чеков</h4>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Проверка Telegram <code className="font-mono text-blue-600">file_unique_id</code>. Дубликаты моментально отклоняются с алертом админу.
                </p>
                <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">
                  Активно (Включено)
                </span>
              </div>

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-2">
                <div className="w-9 h-9 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center">
                  <Clock className="w-5 h-5" />
                </div>
                <h4 className="text-xs font-bold text-slate-900">Авто-таймаут (20 мин)</h4>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Неоплаченные заказы старше 20 минут автоматически отменяются, а бронь товара освобождается для других покупателей.
                </p>
                <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800">
                  Интервал: 1 мин
                </span>
              </div>

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-2">
                <div className="w-9 h-9 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center">
                  <Layers className="w-5 h-5" />
                </div>
                <h4 className="text-xs font-bold text-slate-900">Лимит 1 активного заказа</h4>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Пользователь не может заспамить базу новыми заказами, пока висит предыдущий неподтвержденный заказ.
                </p>
                <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-800">
                  Защита от спама
                </span>
              </div>

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-2">
                <div className="w-9 h-9 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center">
                  <Bot className="w-5 h-5" />
                </div>
                <h4 className="text-xs font-bold text-slate-900">Мульти-администраторы</h4>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Поддержка нескольких админов через переменную <code className="font-mono text-slate-700">ADMIN_IDS</code> через запятую.
                </p>
                <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-700">
                  RBAC доступ
                </span>
              </div>
            </div>

            {/* Блок бэкапа и ручного бана */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Секция скачивания бэкапа */}
              <div className="lg:col-span-5 bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-4">
                <div className="flex items-center gap-2">
                  <Download className="w-5 h-5 text-blue-600" />
                  <h3 className="text-sm font-bold text-slate-900">Резервная копия (Бэкап БД)</h3>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Вы можете скачать файл базы данных SQLite (<code className="font-mono text-blue-700">shop.db</code>) прямо сейчас в браузере или использовать команду <code className="font-mono font-bold text-slate-800">/backup</code> в Telegram-боте.
                </p>
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs text-slate-600 space-y-1">
                  <div className="flex justify-between">
                    <span>Файл базы:</span>
                    <span className="font-mono font-semibold text-slate-800">shop.db</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Таблицы:</span>
                    <span className="font-semibold text-slate-800">products, orders, blacklist</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Связанные заказы:</span>
                    <span className="font-semibold text-slate-800">{orders.length} шт.</span>
                  </div>
                </div>
                <a
                  href="/api/backup"
                  download
                  className="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs transition flex items-center justify-center gap-2 cursor-pointer shadow-xs"
                >
                  <Download className="w-4 h-4" />
                  Скачать shop.db
                </a>
              </div>

              {/* Форма ручной блокировки пользователя */}
              <div className="lg:col-span-7 bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-4">
                <div className="flex items-center gap-2">
                  <UserX className="w-5 h-5 text-red-600" />
                  <h3 className="text-sm font-bold text-slate-900">Добавить нарушителя в черный список</h3>
                </div>
                <p className="text-xs text-slate-600">
                  Заблокированный пользователь полностью лишается доступа ко всем командам и кнопкам бота.
                </p>
                <form onSubmit={handleManualBan} className="grid grid-cols-1 sm:grid-cols-12 gap-3 text-xs">
                  <div className="sm:col-span-4">
                    <label className="block font-medium text-slate-700 mb-1">Telegram User ID:</label>
                    <input
                      type="number"
                      required
                      placeholder="123456789"
                      value={newBanUserId}
                      onChange={(e) => setNewBanUserId(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-red-500 font-mono"
                    />
                  </div>
                  <div className="sm:col-span-5">
                    <label className="block font-medium text-slate-700 mb-1">Причина блокировки:</label>
                    <input
                      type="text"
                      placeholder="Повторные чеки, спам"
                      value={newBanReason}
                      onChange={(e) => setNewBanReason(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-red-500"
                    />
                  </div>
                  <div className="sm:col-span-3 flex items-end">
                    <button
                      type="submit"
                      className="w-full py-2 px-3 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold text-xs transition cursor-pointer flex items-center justify-center gap-1.5"
                    >
                      <UserX className="w-3.5 h-3.5" />
                      В бан
                    </button>
                  </div>
                </form>
              </div>
            </div>

            {/* Таблица черного списка */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
              <div className="p-4 border-b border-slate-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-red-600" />
                  <h3 className="text-sm font-bold text-slate-900">Заблокированные пользователи (Черный список)</h3>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700">
                    {blacklist.length} чел.
                  </span>
                </div>
              </div>

              {blacklist.length === 0 ? (
                <div className="p-10 text-center text-slate-400 space-y-2">
                  <ShieldCheck className="w-8 h-8 mx-auto text-emerald-500" />
                  <p className="text-xs font-medium text-slate-600">Черный список пуст</p>
                  <p className="text-[11px] text-slate-400">Нарушители не зафиксированы или были разблокированы.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider text-[10px]">
                      <tr>
                        <th className="py-3 px-4">Telegram ID</th>
                        <th className="py-3 px-4">Причина</th>
                        <th className="py-3 px-4">Дата блокировки</th>
                        <th className="py-3 px-4 text-right">Действия</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {blacklist.map((item) => (
                        <tr key={item.user_id} className="hover:bg-slate-50/60 transition">
                          <td className="py-3 px-4 font-mono font-bold text-slate-900">
                            {item.user_id}
                          </td>
                          <td className="py-3 px-4">
                            <span className="text-slate-800">{item.reason || 'Нарушение правил'}</span>
                          </td>
                          <td className="py-3 px-4 text-slate-500">
                            {new Date(item.created_at).toLocaleString('ru-RU')}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <button
                              onClick={() => handleUnbanUser(item.user_id)}
                              className="px-2.5 py-1 rounded bg-slate-100 hover:bg-emerald-50 hover:text-emerald-700 text-slate-700 font-medium text-[11px] transition cursor-pointer border border-slate-200"
                            >
                              🔓 Разблокировать
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ВКЛАДКА: ИСХОДНЫЙ КОД */}
        {activeTab === 'code' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Меню файлов */}
            <div className="lg:col-span-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-1">
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-2">Файлы проекта</h3>
              {[
                { name: 'bot.js', desc: 'Telegram бот (Telegraf, меню, FSM, возвраты)' },
                { name: 'wizard.js', desc: 'Пошаговый мастер создания лотов (FSM, откат назад)' },
                { name: 'db.js', desc: 'База данных SQLite (better-sqlite3, stock, бронь)' },
                { name: 'package.json', desc: 'Зависимости и скрипты' },
                { name: '.env.example', desc: 'Переменные окружения' },
              ].map((f) => (
                <button
                  key={f.name}
                  onClick={() => fetchFile(f.name)}
                  className={`w-full text-left p-2.5 rounded-xl transition cursor-pointer flex flex-col ${
                    selectedFile === f.name
                      ? 'bg-blue-50 border border-blue-200 text-blue-800'
                      : 'hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  <span className="font-mono font-bold text-xs">{f.name}</span>
                  <span className="text-[10px] text-slate-400">{f.desc}</span>
                </button>
              ))}
            </div>

            {/* Просмотр содержимого файла */}
            <div className="lg:col-span-9 bg-slate-900 text-slate-100 rounded-2xl p-4 shadow-sm border border-slate-800 flex flex-col">
              <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <FileCode2 className="w-4 h-4 text-blue-400" />
                  <span className="font-mono font-bold text-xs">{selectedFile}</span>
                </div>
                <button
                  onClick={() => copyToClipboard(fileContent, 'file-content')}
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 transition cursor-pointer flex items-center gap-1.5"
                >
                  {copiedKey === 'file-content' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedKey === 'file-content' ? 'Скопировано' : 'Копировать'}
                </button>
              </div>
              <pre className="font-mono text-xs overflow-x-auto leading-relaxed max-h-[600px] overflow-y-auto text-slate-300 p-2">
                {isLoadingFile ? '// Загрузка файла...' : fileContent}
              </pre>
            </div>
          </div>
        )}

      </main>

      {/* Модальное окно просмотра выданных ключей */}
      {viewKeysModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Key className="w-4 h-4 text-amber-600" />
                Выданные ключи (Заказ #{viewKeysModal.order.id})
              </h3>
              <button
                onClick={() => setViewKeysModal(null)}
                className="text-slate-400 hover:text-slate-600 text-xs"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-600">
              Товар: <b>{viewKeysModal.order.product_name}</b> ({viewKeysModal.order.quantity || 1} шт.)
            </p>

            <div className="bg-slate-900 p-3 rounded-xl">
              <pre className="text-emerald-400 font-mono text-xs overflow-x-auto">
                {viewKeysModal.order.delivered_keys || viewKeysModal.order.seller_comment || 'Нет сохраненных ключей'}
              </pre>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => copyToClipboard(viewKeysModal.order.delivered_keys || '', 'modal-keys')}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 transition cursor-pointer flex items-center gap-1.5"
              >
                {copiedKey === 'modal-keys' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedKey === 'modal-keys' ? 'Скопировано' : 'Копировать'}
              </button>
              <button
                onClick={() => setViewKeysModal(null)}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 transition cursor-pointer"
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модальное окно оформления возврата (Refund) */}
      {refundModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-xl border border-slate-200 space-y-4">
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <RotateCcw className="w-4 h-4 text-purple-600" />
              Оформление возврата средств (Refund) #{refundModal.order.id}
            </h3>

            <div className="p-3 bg-slate-50 rounded-xl text-xs space-y-1 text-slate-700">
              <p>Товар: <b>{refundModal.order.product_name}</b></p>
              <p>Количество: <b>{refundModal.order.quantity || 1} шт.</b></p>
              <p>Сумма: <b>{refundModal.order.amount} ₽</b></p>
              <p>Покупатель: ID <code>{refundModal.order.user_id}</code></p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-800 mb-2">
                Вернуть ли товар обратно в наличие на склад?
              </label>
              <div className="space-y-2 text-xs">
                <label className="flex items-center gap-2 p-2.5 rounded-xl border border-slate-200 cursor-pointer hover:bg-slate-50">
                  <input
                    type="radio"
                    name="restock"
                    checked={refundModal.restock === true}
                    onChange={() => setRefundModal({ ...refundModal, restock: true })}
                    className="text-blue-600"
                  />
                  <span>
                    <b>✅ Да, вернуть ключи в наличие</b>
                    <span className="block text-[11px] text-slate-500">Ключи/остаток вернутся на склад и будут доступны к продаже</span>
                  </span>
                </label>
                <label className="flex items-center gap-2 p-2.5 rounded-xl border border-slate-200 cursor-pointer hover:bg-slate-50">
                  <input
                    type="radio"
                    name="restock"
                    checked={refundModal.restock === false}
                    onChange={() => setRefundModal({ ...refundModal, restock: false })}
                    className="text-blue-600"
                  />
                  <span>
                    <b>❌ Нет, списать товар безвозвратно</b>
                    <span className="block text-[11px] text-slate-500">Ключи аннулируются и не вернутся на склад</span>
                  </span>
                </label>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setRefundModal(null)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition cursor-pointer"
              >
                Отмена
              </button>
              <button
                onClick={handleRefundOrder}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 transition cursor-pointer"
              >
                Подтвердить возврат
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модальное окно подтверждения / отклонения заказа */}
      {activeOrderAction && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-xl border border-slate-200 space-y-4">
            <h3 className="text-sm font-bold text-slate-900">
              {activeOrderAction.type === 'approve' ? '🟩 Подтверждение заказа' : '🟥 Отклонение заказа'} #{activeOrderAction.order.id}
            </h3>

            <p className="text-xs text-slate-600">
              Товар: <b>{activeOrderAction.order.product_name}</b> ({activeOrderAction.order.amount} ₽, {activeOrderAction.order.quantity || 1} шт.)
            </p>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {activeOrderAction.type === 'approve' ? 'Комментарий к подтверждению (необязательно)' : 'Причина отказа *'}
              </label>
              <textarea
                rows={3}
                placeholder={
                  activeOrderAction.type === 'approve'
                    ? 'Например: Спасибо за покупку! Ссылка активирована.'
                    : 'Например: Оплата не поступила на карту'
                }
                value={activeOrderAction.comment}
                onChange={(e) => setActiveOrderAction({ ...activeOrderAction, comment: e.target.value })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setActiveOrderAction(null)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition cursor-pointer"
              >
                Отмена
              </button>
              <button
                onClick={() => {
                  if (activeOrderAction.type === 'approve') {
                    handleApproveOrder(activeOrderAction.order.id, activeOrderAction.comment);
                  } else {
                    handleRejectOrder(activeOrderAction.order.id, activeOrderAction.comment || 'Оплата не подтверждена');
                  }
                }}
                className={`px-4 py-1.5 rounded-lg text-xs font-semibold text-white transition cursor-pointer ${
                  activeOrderAction.type === 'approve' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {activeOrderAction.type === 'approve' ? 'Подтвердить заказ' : 'Отклонить заказ'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модальное окно изменения названия и описания товара */}
      {editDetailsModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-xl border border-slate-200 space-y-4">
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-600" />
              Редактирование лота #{editDetailsModal.product.id}
            </h3>

            <form onSubmit={handleUpdateProductDetails} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Название лота *</label>
                <input
                  type="text"
                  required
                  value={editDetailsModal.name}
                  onChange={(e) => setEditDetailsModal({ ...editDetailsModal, name: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500 font-semibold"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Описание лота</label>
                <textarea
                  rows={3}
                  value={editDetailsModal.description}
                  onChange={(e) => setEditDetailsModal({ ...editDetailsModal, description: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditDetailsModal(null)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition cursor-pointer"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 transition cursor-pointer"
                >
                  Сохранить изменения
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Модальное окно изменения цены товара */}
      {editPriceModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl border border-slate-200 space-y-4">
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Edit3 className="w-4 h-4 text-blue-600" />
              Изменение цены
            </h3>
            <p className="text-xs text-slate-600">
              Товар: <b>{editPriceModal.product.name}</b>
            </p>

            <form onSubmit={handleUpdatePrice} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Новая цена (₽):</label>
                <input
                  type="number"
                  min={1}
                  required
                  value={editPriceModal.price}
                  onChange={(e) => setEditPriceModal({ ...editPriceModal, price: e.target.value })}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500 font-bold"
                />
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditPriceModal(null)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition cursor-pointer"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 transition cursor-pointer"
                >
                  Сохранить
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Модальное окно пополнения товара / ключей */}
      {replenishModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-xl border border-slate-200 space-y-4">
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Plus className="w-4 h-4 text-blue-600" />
              Пополнение наличия товара
            </h3>
            <p className="text-xs text-slate-600">
              Товар: <b>{replenishModal.product.name}</b> ({replenishModal.product.delivery_type === 'AUTO' ? '⚡ Автовыдача' : '✍️ Ручная'})
            </p>

            <form onSubmit={handleReplenishStock} className="space-y-3 text-xs">
              {replenishModal.product.delivery_type === 'AUTO' ? (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Дополнительные ключи / данные (каждый с новой строки):
                  </label>
                  <textarea
                    rows={4}
                    required
                    placeholder={"NEW-KEY-1111\nNEW-KEY-2222"}
                    value={replenishModal.additionalKeys}
                    onChange={(e) => setReplenishModal({ ...replenishModal, additionalKeys: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500 font-mono text-[11px]"
                  />
                  <p className="text-[10px] text-slate-400 mt-1">
                    Строки будут добавлены в очередь выдачи, а количество на складе увеличится на число строк.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl border border-slate-200">
                    <span className="font-medium text-slate-700">Сделать бесконечным лотом (inf)?</span>
                    <input
                      type="checkbox"
                      checked={replenishModal.setUnlimited}
                      onChange={(e) => setReplenishModal({ ...replenishModal, setUnlimited: e.target.checked })}
                      className="w-4 h-4 text-blue-600 rounded cursor-pointer"
                    />
                  </div>

                  {!replenishModal.setUnlimited && (
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">
                        Сколько штук добавить к текущему остатку ({replenishModal.product.stock} шт.)?
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={replenishModal.addStock}
                        onChange={(e) => setReplenishModal({ ...replenishModal, addStock: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg border border-slate-200"
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setReplenishModal(null)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition cursor-pointer"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 transition cursor-pointer"
                >
                  Пополнить склад
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Модальное окно изменения лимитов пополнения (FLEXIBLE) */}
      {editFlexibleModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl border border-slate-200 space-y-4">
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Edit3 className="w-4 h-4 text-blue-600" />
              Параметры пополнения
            </h3>
            <p className="text-xs text-slate-600">
              Товар: <b>{editFlexibleModal.product.name}</b> (💳 Пополнение)
            </p>

            <form onSubmit={handleUpdateFlexible} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Мин. сумма (₽):</label>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  required
                  value={editFlexibleModal.min_amount}
                  onChange={(e) => setEditFlexibleModal({ ...editFlexibleModal, min_amount: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500 font-semibold"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Макс. сумма (₽):</label>
                <input
                  type="number"
                  step="0.01"
                  min={1}
                  required
                  value={editFlexibleModal.max_amount}
                  onChange={(e) => setEditFlexibleModal({ ...editFlexibleModal, max_amount: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500 font-semibold"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Комиссия сервиса (%):</label>
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  required
                  value={editFlexibleModal.fee_percent}
                  onChange={(e) => setEditFlexibleModal({ ...editFlexibleModal, fee_percent: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500 font-semibold"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Сумма к оплате будет рассчитана как <code>Сумма + (Сумма * % / 100)</code>
                </p>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditFlexibleModal(null)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition cursor-pointer"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 transition cursor-pointer"
                >
                  Сохранить
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
