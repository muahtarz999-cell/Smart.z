/**
 * Several Groq accounts (server only). Keys come from GROQ_API_KEY and
 * GROQ_API_KEY_2 … GROQ_API_KEY_5 (GROQ_API_KEY_1 is accepted too). Requests
 * rotate across them so the free daily limits add up, and a key that answers
 * 429 (rate limit) or 401/403 (revoked, terms not accepted) rests for a while
 * so the next request goes straight to a healthy one.
 */

export const MAX_GROQ_KEYS = 5;
const RATE_LIMIT_REST_MS = 60_000;
const AUTH_REST_MS = 10 * 60_000;

const resting = new Map(); // key -> timestamp until which it is skipped
let cursor = 0;

export function getGroqKeys() {
  const names = ['GROQ_API_KEY', 'GROQ_API_KEY_1'];
  for (let index = 2; index <= MAX_GROQ_KEYS; index += 1) names.push(`GROQ_API_KEY_${index}`);
  const keys = [];
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value && !keys.includes(value)) keys.push(value);
  }
  return keys.slice(0, MAX_GROQ_KEYS);
}

export function hasGroqKey() {
  return getGroqKeys().length > 0;
}

/**
 * All keys, healthy ones first, starting from a rotating position. Resting
 * keys stay at the end so a request still has something to try when every
 * key is resting.
 */
export function groqKeysInOrder(now = Date.now()) {
  const keys = getGroqKeys();
  if (!keys.length) return [];
  const start = cursor % keys.length;
  cursor = (cursor + 1) % 1_000_000;
  const rotated = [...keys.slice(start), ...keys.slice(0, start)];
  const healthy = rotated.filter((key) => !((resting.get(key) || 0) > now));
  const tired = rotated.filter((key) => (resting.get(key) || 0) > now);
  return [...healthy, ...tired];
}

/** Records a failed answer. status 0 = network error or timeout (not the key's fault). */
export function reportGroqFailure(key, status, now = Date.now()) {
  if (!key) return;
  if (status === 429) resting.set(key, now + RATE_LIMIT_REST_MS);
  else if (status === 401 || status === 403) resting.set(key, now + AUTH_REST_MS);
}

/** Worth trying the next key: the problem belongs to this key, not to Groq as a whole. */
export function isKeySpecificFailure(status) {
  return status === 429 || status === 401 || status === 403;
}

/** Tests only. */
export function resetGroqKeyState() {
  resting.clear();
  cursor = 0;
}
