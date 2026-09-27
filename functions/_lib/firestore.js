export const PROJECT_ID = 'layansbeautyshop-d8135';

const SCOPE = 'https://www.googleapis.com/auth/datastore';
let cachedToken = null;

function projectId(env) {
  return env.FIREBASE_PROJECT_ID || PROJECT_ID;
}

export function databaseUrl(env) {
  const host = env.FIRESTORE_EMULATOR_HOST;
  const origin = host ? `http://${host}` : 'https://firestore.googleapis.com';
  return `${origin}/v1/projects/${projectId(env)}/databases/(default)/documents`;
}

function base64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signJwt(account) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: account.client_email, scope: SCOPE, aud: account.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const pem = account.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), char => char.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${base64url(signature)}`;
}

async function accessToken(env) {
  if (env.FIRESTORE_EMULATOR_HOST) return 'owner';
  if (cachedToken && cachedToken.expires > Date.now() + 60000) return cachedToken.value;
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured');
  const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const response = await fetch(account.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: await signJwt(account) })
  });
  if (!response.ok) throw new Error(`Firebase sign-in failed (${response.status})`);
  const token = await response.json();
  cachedToken = { value: token.access_token, expires: Date.now() + token.expires_in * 1000 };
  return cachedToken.value;
}

export async function firestore(env, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${databaseUrl(env)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(env)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) {
    const error = new Error(`Firestore ${method} ${response.status}`);
    error.status = response.status;
    error.detail = await response.text();
    throw error;
  }
  return response.json();
}

export function documentName(env, path) {
  return `projects/${projectId(env)}/databases/(default)/documents/${path}`;
}

export function toValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (value instanceof Uint8Array) return { bytesValue: base64Bytes(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  switch (typeof value) {
    case 'boolean': return { booleanValue: value };
    case 'number': return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    case 'string': return { stringValue: value };
    case 'object': return { mapValue: { fields: toFields(value) } };
  }
  throw new Error(`Unsupported Firestore value: ${typeof value}`);
}

export function toFields(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toValue(v)]));
}

export function fromValue(value) {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('bytesValue' in value) return Uint8Array.from(atob(value.bytesValue), char => char.charCodeAt(0));
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(fromValue);
  if ('mapValue' in value) return fromFields(value.mapValue.fields || {});
  return null;
}

export function fromFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, fromValue(v)]));
}

export function fromDocument(doc) {
  return { id: doc.name.split('/').pop(), ...fromFields(doc.fields) };
}

function base64Bytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function listDocuments(env, collection) {
  const documents = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({ pageSize: '300' });
    if (pageToken) query.set('pageToken', pageToken);
    const page = await firestore(env, `/${collection}?${query}`);
    documents.push(...(page?.documents || []));
    pageToken = page?.nextPageToken || '';
  } while (pageToken);
  return documents.map(fromDocument);
}
