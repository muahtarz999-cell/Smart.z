/**
 * Smart.z Windows Agent – secure local identity store (Encrypted with AES-256-GCM)
 *
 * The private key and identity are encrypted using a machine-bound derived key
 * so they are never stored in plaintext on disk.
 */

import { readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import os from 'node:os';

const DIR = dirname(fileURLToPath(import.meta.url));
const IDENTITY_FILE = join(DIR, 'agent-identity.enc');
const LEGACY_IDENTITY_FILE = join(DIR, 'agent-identity.json');

// Derive a machine-bound encryption key
function getMachineEncryptionKey() {
  const seed = [
    os.hostname(),
    os.userInfo().username,
    os.platform(),
    os.arch(),
    os.homedir(),
    'smartz-windows-agent-secret-v1',
  ].join('|');
  return createHash('sha256').update(seed, 'utf8').digest();
}

export function identityExists() {
  return existsSync(IDENTITY_FILE) || existsSync(LEGACY_IDENTITY_FILE);
}

export async function loadIdentity() {
  let raw;
  let isEncrypted = true;

  if (existsSync(IDENTITY_FILE)) {
    raw = await readFile(IDENTITY_FILE, 'utf-8');
  } else if (existsSync(LEGACY_IDENTITY_FILE)) {
    raw = await readFile(LEGACY_IDENTITY_FILE, 'utf-8');
    isEncrypted = false;
  } else {
    throw new Error('لم يتم العثور على ملف هوية الجهاز. شغّل node pair.mjs أولاً.');
  }

  let parsed;
  if (isEncrypted) {
    const { iv, tag, ciphertext } = JSON.parse(raw);
    const key = getMachineEncryptionKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]);
    parsed = JSON.parse(decrypted.toString('utf8'));
  } else {
    parsed = JSON.parse(raw);
    // Migrate legacy plaintext to encrypted automatically
    await saveIdentity(parsed);
    await rm(LEGACY_IDENTITY_FILE, { force: true }).catch(() => {});
  }

  if (
    !parsed ||
    typeof parsed.privateKeyBase64url !== 'string' ||
    typeof parsed.publicKeyBase64url !== 'string' ||
    typeof parsed.deviceId !== 'string' ||
    typeof parsed.baseUrl !== 'string'
  ) {
    throw new Error('ملف هوية الجهاز تالف أو غير مكتمل.');
  }
  return parsed;
}

export async function saveIdentity(identity) {
  const key = getMachineEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(identity, null, 2), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = JSON.stringify({
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  });

  await writeFile(IDENTITY_FILE, payload, 'utf-8');
  // Remove legacy plaintext file if it exists
  if (existsSync(LEGACY_IDENTITY_FILE)) {
    await rm(LEGACY_IDENTITY_FILE, { force: true }).catch(() => {});
  }
}

export async function deleteIdentity() {
  if (existsSync(IDENTITY_FILE)) await rm(IDENTITY_FILE, { force: true });
  if (existsSync(LEGACY_IDENTITY_FILE)) await rm(LEGACY_IDENTITY_FILE, { force: true });
}

export { IDENTITY_FILE };
