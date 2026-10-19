import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
} from 'node:crypto';

export function hashPairingSecret(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createPairingSecret() {
  return randomBytes(32).toString('base64url');
}

export function createPairingChallenge() {
  return randomBytes(32).toString('base64url');
}

export function pairingProofMessage(sessionId, challenge) {
  return `smartz-computer-pairing:v1:${sessionId}:${challenge}`;
}

export function isValidPairingSecret(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function validateComputerPublicKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{58,64}$/.test(value)) {
    return false;
  }

  try {
    const der = Buffer.from(value, 'base64url');
    if (der.toString('base64url') !== value) return false;
    const key = createPublicKey({
      key: der,
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

export function verifyComputerPairingProof(publicKey, sessionId, challenge, signature) {
  if (
    !validateComputerPublicKey(publicKey) ||
    !isValidPairingSecret(challenge) ||
    typeof signature !== 'string' ||
    !/^[A-Za-z0-9_-]{86}$/.test(signature)
  ) {
    return false;
  }

  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return verify(
      null,
      Buffer.from(pairingProofMessage(sessionId, challenge), 'utf8'),
      key,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

export function hashPairingClientIp(request) {
  const forwarded = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-real-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
  return hashPairingSecret(forwarded);
}
