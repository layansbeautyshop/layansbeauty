import { firestore, fromDocument } from '../../_lib/firestore.js';
import { PHOTO_ID } from '../../_lib/catalogue.js';

const TYPES = /^image\/(?:webp|jpeg|png|gif|avif)$/;

export async function onRequestGet(context) {
  const id = String(context.params.id || '');
  if (!PHOTO_ID.test(id)) return new Response('Invalid photo.', { status: 400 });
  const cache = globalThis.caches?.default;
  const cached = cache && await cache.match(context.request);
  if (cached) return cached;
  let doc;
  try {
    doc = await firestore(context.env, `/photos/${id}`);
  } catch (error) {
    console.error('Photo read failed', error.status, error.detail || error.message);
    return new Response('Unable to load photo.', { status: 502 });
  }
  if (!doc) return new Response('Photo not found.', { status: 404 });
  const photo = fromDocument(doc);
  if (!(photo.data instanceof Uint8Array) || !TYPES.test(photo.type)) return new Response('Invalid photo data.', { status: 422 });
  const response = new Response(photo.data, { headers: {
    'Content-Type': photo.type,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*'
  } });
  if (cache) context.waitUntil(cache.put(context.request, response.clone()));
  return response;
}
