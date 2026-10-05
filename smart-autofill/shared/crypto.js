// Web Crypto helpers: PBKDF2-SHA256 key derivation + AES-GCM-256 encryption of JSON values.
const enc = new TextEncoder();
const dec = new TextDecoder();
export const ITERATIONS = 310000;

export function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function randomBytes(n) { return crypto.getRandomValues(new Uint8Array(n)); }

export async function deriveKey(passphrase, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}
export async function exportKey(key) { return toB64(await crypto.subtle.exportKey('raw', key)); }
export async function importKey(b64) {
  return crypto.subtle.importKey('raw', fromB64(b64), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}
export async function encryptJSON(key, value) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return { iv: toB64(iv), ct: toB64(ct) };
}
export async function decryptJSON(key, blob) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
  return JSON.parse(dec.decode(pt));
}
// Self-contained envelope (used for vault-independent exports).
export async function sealWithPassphrase(passphrase, value) {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const { iv, ct } = await encryptJSON(key, value);
  return { kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: toB64(salt), cipher: 'AES-GCM-256', iv, ct };
}
export async function openWithPassphrase(passphrase, env) {
  const key = await deriveKey(passphrase, fromB64(env.salt), env.iterations || ITERATIONS);
  return decryptJSON(key, env);
}
