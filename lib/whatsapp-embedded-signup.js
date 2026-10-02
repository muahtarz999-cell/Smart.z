function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function importStateKey(appSecret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function createSignedSignupState(userId, appSecret) {
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ userId, expiresAt: Date.now() + 10 * 60 * 1000, nonce: crypto.randomUUID() })
    )
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    await importStateKey(appSecret),
    new TextEncoder().encode(payload)
  );
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySignedSignupState(state, appSecret) {
  if (typeof state !== 'string') return null;
  const [payload, signature, extra] = state.split('.');
  if (!payload || !signature || extra) return null;

  const valid = await crypto.subtle.verify(
    'HMAC',
    await importStateKey(appSecret),
    fromBase64Url(signature),
    new TextEncoder().encode(payload)
  );
  if (!valid) return null;

  const decoded = new TextDecoder().decode(fromBase64Url(payload));
  const result = JSON.parse(decoded);
  if (typeof result.userId !== 'string' || result.expiresAt < Date.now()) return null;
  return result;
}
