import '../config.js';
import { AviedoClient } from '../supplier.js';
try {
  const api = new AviedoClient();
  const balance = await api.balance();
  const products = await api.products();
  console.log(JSON.stringify({ readOnly: true, connected: true,
    balance: balance.data, productsShape: Array.isArray(products.data) ? 'array' : Object.keys(products.data || {}),
    productCount: Array.isArray(products.data) ? products.data.length : (products.data?.products?.length ?? null),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ readOnly: true, connected: false, code: error.code || 'local_error' }));
  process.exitCode = 1;
}
