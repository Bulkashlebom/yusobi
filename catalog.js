export function catalogCard(product) {
  const section = product.section?.name || '';
  const category = product.category?.name || '';
  const group = product.group?.name || '';
  const title = [section, product.name].filter(Boolean).join(' — ');
  const fields = (product.fields || []).filter(field => field.required);
  const delivery = product.kind === 'manual'
    ? 'Выполнение заказа специалистом поставщика.'
    : product.result === 'item'
      ? 'Данные товара будут отправлены после выполнения заказа.'
      : 'Зачисление на указанный аккаунт после выполнения заказа.';
  const lines = [title];
  if (category) lines.push(`Вариант: ${category}`);
  if (group && group !== product.name) lines.push(`Группа: ${group}`);
  lines.push('', delivery);
  if (product.eta) lines.push(`Срок по информации поставщика: ${product.eta}`);
  if (fields.length) lines.push(`Для оформления: ${fields.map(field => field.label).join(', ')}.`);
  if (product.requires?.end_user_action || product.requires?.email_code) {
    lines.push('Во время выполнения может потребоваться ваше участие.');
  }
  lines.push('Перед оплатой проверьте выбранный вариант и данные получателя.');
  return { supplierId: product.id, title, description: lines.join('\n'),
    section: product.section, category: product.category, group: product.group,
    supplierPrice: product.price, quantity: product.quantity,
    available: product.available === true && product.stock?.in_stock === true,
    kind: product.kind, requires: product.requires, fields: product.fields,
    fieldsVersion: product.fields_version, retailPrice: null, published: false };
}

export function catalogPreview(products) {
  if (!Array.isArray(products)) throw new Error('Aviedo products must be an array');
  const ids = new Set();
  return products.map(product => {
    if (!Number.isSafeInteger(product.id) || ids.has(product.id)) throw new Error('Invalid or duplicated supplier ID');
    ids.add(product.id);
    return catalogCard(product);
  });
}
