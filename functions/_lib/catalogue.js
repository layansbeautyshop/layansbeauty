import { firestore, fromDocument, listDocuments } from './firestore.js';

export const PHOTO_ID = /^[a-f0-9]{24}$/;

export function photoUrl(value) {
  return typeof value === 'string' && PHOTO_ID.test(value) ? `/api/photo/${value}` : value || '';
}

export function publicProduct(doc) {
  const shades = (doc.shades || []).map((shade, index) => {
    const images = (shade.images || []).map(photoUrl).filter(Boolean);
    return { id: shade.id ?? `shade-${index}`, name: shade.name || '', color: shade.color || '#E8A5A5',
      stock: shade.stock ?? null, image: images[0] || '', images, _index: index };
  });
  return {
    id: doc.id, name: doc.name ?? '', nameEn: doc.nameEn ?? '', price: doc.price ?? null,
    original_price: doc.original_price ?? null, discount_pct: doc.discount_pct ?? null,
    on_sale: !!doc.on_sale, description: doc.description ?? '', stock: doc.stock ?? null,
    category: doc.category ?? '', created_at: doc.created_at ?? null,
    shades, images: shades.map(shade => shade.image).filter(Boolean)
  };
}

export async function readProducts(env) {
  const docs = await listDocuments(env, 'products');
  return docs.map(publicProduct).sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)) || String(a.id).localeCompare(String(b.id)));
}

export async function readVersion(env) {
  const doc = await firestore(env, '/meta/catalogue');
  return doc ? String(fromDocument(doc).version ?? 0) : '0';
}

export function versionWrite(env, documentName) {
  return {
    update: { name: documentName(env, 'meta/catalogue'), fields: { version: { integerValue: String(Date.now()) } } }
  };
}

export async function readProduct(env, id) {
  const doc = await firestore(env, `/products/${encodeURIComponent(id)}`);
  return doc ? publicProduct(fromDocument(doc)) : null;
}
