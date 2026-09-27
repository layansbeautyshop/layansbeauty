import { documentName, firestore, fromDocument, toFields } from '../_lib/firestore.js';
import { versionWrite } from '../_lib/catalogue.js';

export const DELIVERY_OPTIONS = [
  { id: 'd1', name: 'استلام مجاني من نقطة جامعة القدس - أبو ديس', price: 0 },
  { id: 'd2', name: 'توصيل إلى مدن الضفة الغربية', price: 20 },
  { id: 'd3', name: 'توصيل إلى القدس', price: 30 },
  { id: 'd4', name: 'توصيل إلى الداخل المحتل', price: 70 }
];
export const GIFT_BOX_PRICE = 10;

class OrderError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

function text(value, max, required = false, label = 'Field') {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) throw new OrderError('invalid', `${label} is required`);
  if (result.length > max) throw new OrderError('invalid', `${label} is too long`);
  return result;
}

const money = value => Math.round(Number(value) * 100) / 100;

export function parseOrder(body) {
  if (!body || typeof body !== 'object') throw new OrderError('invalid', 'Invalid order');
  const customer = {
    customer_name: text(body.customer_name, 120, true, 'Customer name'),
    phone: text(body.phone, 40, true, 'Phone number'),
    address: text(body.address, 300, true, 'Address'),
    address_alt: text(body.address_alt, 300),
    phone_alt: text(body.phone_alt, 40),
    notes: text(body.notes, 1000)
  };
  if (!Array.isArray(body.items) || !body.items.length) throw new OrderError('invalid', 'Order has no items');
  if (body.items.length > 50) throw new OrderError('invalid', 'Too many items');
  const items = body.items.map(item => {
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw new OrderError('invalid', 'Invalid quantity');
    const productId = String(item.productId ?? '');
    if (!/^[\w-]{1,100}$/.test(productId)) throw new OrderError('invalid', 'Unknown product');
    return { productId, shadeId: String(item.shadeId ?? ''), quantity, price: Number(item.price) };
  });
  const delivery = DELIVERY_OPTIONS.find(option => option.price === Number(body.delivery_price));
  if (!delivery) throw new OrderError('invalid', 'Unknown delivery option');
  return { customer, items, delivery, giftBox: body.gift_box === true, total: Number(body.total) };
}

function effectiveStock(product, shade) {
  const raw = shade && shade.stock !== undefined && shade.stock !== null ? shade.stock : product.stock;
  const n = raw === null || raw === undefined || raw === '' || typeof raw === 'boolean' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function priceOrder(order, products) {
  const lines = [];
  const remaining = new Map();
  for (const item of order.items) {
    const product = products.get(item.productId);
    if (!product) throw new OrderError('invalid', 'Unknown product');
    const shades = Array.isArray(product.shades) ? product.shades : [];
    const shade = shades.find(s => String(s?.id) === item.shadeId);
    if (shades.length && !shade) throw new OrderError('stock', 'Unknown shade', 409);
    const price = Number(product.price);
    if (!Number.isFinite(price) || money(item.price) !== money(price)) {
      throw new OrderError('pricing', 'Order does not match expected pricing', 409);
    }
    const key = `${item.productId}\u0000${shade ? item.shadeId : ''}`;
    const available = remaining.has(key) ? remaining.get(key) : effectiveStock(product, shade);
    if (available === null || available < item.quantity) throw new OrderError('stock', 'Insufficient stock', 409);
    remaining.set(key, available - item.quantity);
    lines.push({ id: item.productId, shade_id: shade ? item.shadeId : '', name: product.name || '',
      shade: shade?.name || 'الأساسي', quantity: item.quantity, price });
  }
  const subtotal = money(lines.reduce((sum, line) => sum + line.price * line.quantity, 0));
  const giftBoxPrice = order.giftBox ? GIFT_BOX_PRICE : 0;
  const total = money(subtotal + order.delivery.price + giftBoxPrice);
  if (money(order.total) !== total) throw new OrderError('pricing', 'Order does not match expected pricing', 409);
  return { lines, subtotal, giftBoxPrice, total, remaining };
}

export function stockUpdates(products, remaining) {
  const updates = new Map();
  for (const [key, stock] of remaining) {
    const [productId, shadeId] = key.split('\u0000');
    const product = updates.get(productId) || structuredClone(products.get(productId));
    if (shadeId) {
      product.shades = product.shades.map(s => String(s?.id) === shadeId && s.stock !== null && s.stock !== undefined ? { ...s, stock } : s);
      const ownStock = product.shades.some(s => String(s?.id) === shadeId && s.stock !== null && s.stock !== undefined);
      if (!ownStock) product.stock = stock;
      else if (product.shades.every(s => Number.isFinite(Number(s?.stock)) && s?.stock !== null)) {
        product.stock = product.shades.reduce((sum, s) => sum + Number(s.stock), 0);
      }
    } else {
      product.stock = stock;
    }
    updates.set(productId, product);
  }
  return updates;
}

function orderCode() {
  const digits = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return `LB-${String(digits).padStart(6, '0')}`;
}

async function placeOrder(env, order) {
  const ids = [...new Set(order.items.map(item => item.productId))];
  for (let attempt = 0; attempt < 4; attempt++) {
    const { transaction } = await firestore(env, ':beginTransaction', { method: 'POST', body: {} });
    try {
      const found = await firestore(env, ':batchGet', { method: 'POST', body: {
        transaction, documents: ids.map(id => documentName(env, `products/${id}`))
      } });
      const products = new Map(found.filter(entry => entry.found).map(entry => {
        const product = fromDocument(entry.found);
        return [product.id, product];
      }));
      const priced = priceOrder(order, products);
      const code = orderCode();
      const writes = [...stockUpdates(products, priced.remaining)].map(([id, product]) => ({
        update: { name: documentName(env, `products/${id}`), fields: toFields({ shades: product.shades, stock: product.stock }) },
        updateMask: { fieldPaths: ['shades', 'stock'] },
        currentDocument: { exists: true }
      }));
      writes.push(versionWrite(env, documentName));
      writes.push({
        update: { name: documentName(env, `orders/${code}`), fields: toFields({
          ...order.customer, order_code: code, items: priced.lines, subtotal: priced.subtotal,
          delivery_name: order.delivery.name, delivery_price: order.delivery.price,
          gift_box: order.giftBox, gift_box_price: priced.giftBoxPrice, total: priced.total,
          status: 'new', created_at: new Date()
        }) },
        currentDocument: { exists: false }
      });
      await firestore(env, ':commit', { method: 'POST', body: { transaction, writes } });
      return { order_code: code, subtotal: priced.subtotal, total: priced.total };
    } catch (error) {
      await firestore(env, ':rollback', { method: 'POST', body: { transaction } }).catch(() => {});
      if (error.status === 409 && !(error instanceof OrderError) && attempt < 3) continue;
      throw error;
    }
  }
}

export async function onRequestPost(context) {
  let order;
  try {
    order = parseOrder(await context.request.json());
  } catch (error) {
    return reply({ error: error instanceof OrderError ? error.message : 'Invalid order', code: 'invalid' }, 422);
  }
  try {
    return reply(await placeOrder(context.env, order));
  } catch (error) {
    if (error instanceof OrderError) return reply({ error: error.message, code: error.code }, error.status);
    console.error('Order save failed', error.status, error.detail || error.message);
    return reply({ error: 'Unable to save order', code: 'server' }, 502);
  }
}
