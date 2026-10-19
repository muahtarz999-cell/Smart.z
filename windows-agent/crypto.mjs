/**
 * Smart.z Windows Agent – crypto helpers
 * Ed25519 key generation, signing, and pairing proof.
 * Uses only Node.js built-in crypto (no extra dependencies).
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';

// ─── Key generation ──────────────────────────────────────────────────────────

/**
 * Generate a new Ed25519 key pair.
 * @returns {{ privateKeyBase64url: string, publicKeyBase64url: string }}
 */
export function generateKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  return {
    privateKeyBase64url: privateKey.toString('base64url'),
    publicKeyBase64url: publicKey.toString('base64url'),
  };
}

// ─── Pairing proof (used in /complete) ───────────────────────────────────────

/**
 * Build proof message: smartz-computer-pairing:v1:<sessionId>:<challenge>
 */
function pairingProofMessage(sessionId, challenge) {
  return `smartz-computer-pairing:v1:${sessionId}:${challenge}`;
}

/**
 * Sign the pairing proof with the private key.
 * @param {string} privateKeyBase64url  PKCS#8 DER encoded, base64url
 * @param {string} sessionId
 * @param {string} challenge            base64url, 43 chars
 * @returns {string}                    signature base64url (~86 chars)
 */
export function signPairingProof(privateKeyBase64url, sessionId, challenge) {
  const pk = createPrivateKey({
    key: Buffer.from(privateKeyBase64url, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  const msg = Buffer.from(pairingProofMessage(sessionId, challenge), 'utf8');
  return sign(null, msg, pk).toString('base64url');
}

// ─── Request signing (used in every agent API call) ──────────────────────────

/**
 * Build the signed request message:
 *   smartz-computer-request:v1\n<METHOD>\n<pathname>\n<timestamp>\n<nonce>\n<bodyHash>
 */
function requestMessage(method, pathname, timestamp, nonce, body) {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return [
    'smartz-computer-request:v1',
    method.toUpperCase(),
    pathname,
    timestamp,
    nonce,
    bodyHash,
  ].join('\n');
}

/**
 * Generate a fresh nonce (32 random url-safe chars).
 */
export function makeNonce() {
  return randomBytes(24).toString('base64url'); // 32 url-safe chars
}

/**
 * Current unix timestamp as a 10-digit decimal string.
 */
export function makeTimestamp() {
  return String(Math.floor(Date.now() / 1000));
}

/**
 * Sign a request and return the three required headers.
 *
 * @param {object} opts
 * @param {string} opts.privateKeyBase64url  PKCS#8 DER, base64url
 * @param {string} opts.method              HTTP method
 * @param {string} opts.pathname            URL path, must start with /api/computer/devices/
 * @param {Buffer|Uint8Array} opts.body     raw request body bytes (may be empty)
 * @returns {{ 'x-smartz-timestamp': string, 'x-smartz-nonce': string, 'x-smartz-signature': string }}
 */
export function signRequest({ privateKeyBase64url, method, pathname, body = Buffer.alloc(0) }) {
  const timestamp = makeTimestamp();
  const nonce = makeNonce();
  const pk = createPrivateKey({
    key: Buffer.from(privateKeyBase64url, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  const msg = Buffer.from(requestMessage(method, pathname, timestamp, nonce, body), 'utf8');
  const signature = sign(null, msg, pk).toString('base64url');
  return {
    'x-smartz-timestamp': timestamp,
    'x-smartz-nonce': nonce,
    'x-smartz-signature': signature,
  };
}
