/**
 * Meta's signed_request (data deletion callback): "<signature>.<payload>",
 * both base64url. The signature is HMAC-SHA256 of the raw payload string with
 * the app secret. Web Crypto only, so it runs on the edge runtime.
 */

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret, usage) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** Returns the decoded payload ({ user_id, algorithm, issued_at, … }) or null when missing, malformed or forged. */
export async function parseSignedRequest(signedRequest, appSecret) {
  if (typeof signedRequest !== 'string' || !appSecret) return null;
  const dot = signedRequest.indexOf('.');
  if (dot <= 0 || dot === signedRequest.length - 1) return null;
  const encodedSignature = signedRequest.slice(0, dot);
  const encodedPayload = signedRequest.slice(dot + 1);
  try {
    const signature = base64UrlToBytes(encodedSignature);
    const key = await hmacKey(appSecret, 'verify');
    const valid = await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(encodedPayload));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload)));
    if (String(payload?.algorithm || '').toUpperCase() !== 'HMAC-SHA256' || !payload.user_id) return null;
    return payload;
  } catch {
    return null;
  }
}

/** A short, stable code for one deletion request: the same request always gets the same code. */
export async function confirmationCode(userId, issuedAt, appSecret) {
  const key = await hmacKey(appSecret, 'sign');
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`deletion:${userId}:${issuedAt}`)));
  return Array.from(mac.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}
