import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPreview } from '../catalog.js';

test('catalog preserves region and manual delivery without inventing retail prices', () => {
  const [card] = catalogPreview([{ id: 1, name: 'Family • 1 месяц', kind: 'manual', result: 'service',
    section: { id: 43, name: 'Spotify' }, category: { id: 86, name: 'Подписки (EG)' },
    price: { currency: 'USD', unit_price: '3.37' }, available: true, stock: { in_stock: true },
    fields: [{ key: 'login', label: 'Логин', required: true }], requires: { chat: true } }]);
  assert.ok(card.description.includes('Подписки (EG)'));
  assert.ok(card.description.includes('специалистом'));
  assert.equal(card.retailPrice, null);
  assert.equal(card.published, false);
  assert.equal(card.supplierId, 1);
});

test('catalog retains unavailable products as unavailable and rejects duplicate IDs', () => {
  const product = { id: 2, name: 'Code', kind: 'uploaded', result: 'item', available: false };
  assert.equal(catalogPreview([product])[0].available, false);
  assert.throws(() => catalogPreview([product, product]), /duplicated/);
});
