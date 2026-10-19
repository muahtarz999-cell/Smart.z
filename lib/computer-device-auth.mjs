import { createHash, createPublicKey, sign, verify } from 'node:crypto';

const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const PUBLIC_KEY_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function computerRequestMessage(method, pathname, timestamp, nonce, body) {
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

export function isComputerRequestNonce(value) {
  return typeof value === 'string' && NONCE_PATTERN.test(value);
}

export function verifyComputerRequest({
  publicKey,
  method,
  pathname,
  timestamp,
  nonce,
  signature,
  body,
  now = Date.now(),
}) {
  if (
    typeof publicKey !== 'string' ||
    !/^[A-Za-z0-9_-]{58,64}$/.test(publicKey) ||
    typeof timestamp !== 'string' ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 120 ||
    !isComputerRequestNonce(nonce) ||
    typeof signature !== 'string' ||
    !SIGNATURE_PATTERN.test(signature) ||
    typeof pathname !== 'string' ||
    !pathname.startsWith('/api/computer/devices/')
  ) {
    return false;
  }

  try {
    const keyBytes = Buffer.from(publicKey, 'base64url');
    if (keyBytes.toString('base64url') !== publicKey || keyBytes.length !== 44) return false;
    const key = createPublicKey({
      key: Buffer.concat([PUBLIC_KEY_PREFIX, keyBytes.subarray(-32)]),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519' && verify(
      null,
      Buffer.from(computerRequestMessage(method, pathname, timestamp, nonce, body)),
      key,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

export function signComputerRequest({
  privateKey,
  method,
  pathname,
  timestamp,
  nonce,
  body,
}) {
  return sign(
    null,
    Buffer.from(computerRequestMessage(method, pathname, timestamp, nonce, body)),
    privateKey,
  ).toString('base64url');
}
