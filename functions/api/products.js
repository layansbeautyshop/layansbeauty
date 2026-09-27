import { readProduct, readProducts, readVersion } from '../_lib/catalogue.js';

const json = (body, cacheControl, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl }
});

async function currentVersion(context, cache, origin) {
  const key = new Request(`${origin}/api/products/version`);
  const cached = cache && await cache.match(key);
  if (cached) return cached.text();
  const version = await readVersion(context.env);
  if (cache) context.waitUntil(cache.put(key, new Response(version, { headers: { 'Cache-Control': 'public, s-maxage=30' } })));
  return version;
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const id = url.searchParams.get('id');
  try {
    if (id !== null) {
      if (!/^[\w-]{1,100}$/.test(id)) return json({ error: 'Invalid product' }, 'no-store', 400);
      const product = await readProduct(context.env, id);
      return product ? json(product, 'no-store') : json({ error: 'Product not found' }, 'no-store', 404);
    }
    const cache = globalThis.caches?.default;
    const version = await currentVersion(context, cache, url.origin);
    const key = new Request(`${url.origin}/api/products?v=${encodeURIComponent(version)}`);
    const cached = cache && await cache.match(key);
    if (cached) return cached;
    const response = json(await readProducts(context.env), 'public, max-age=30, s-maxage=86400');
    if (cache) context.waitUntil(cache.put(key, response.clone()));
    return response;
  } catch (error) {
    console.error('Catalogue read failed', error.status, error.detail || error.message);
    return json({ error: 'Unable to load products' }, 'no-store', 502);
  }
}
