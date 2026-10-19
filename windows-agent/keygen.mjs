/**
 * Smart.z Windows Agent – keygen
 *
 * Usage:  node keygen.mjs
 *
 * Generates a fresh Ed25519 key pair and saves keys-pending.json in this
 * directory.  Run `pair.mjs` next to complete pairing.
 *
 * The private key is stored ONLY locally.  It is never sent to the server.
 */

import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair } from './crypto.mjs';
import { identityExists } from './identity.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const PENDING_FILE = join(DIR, 'keys-pending.json');

async function main() {
  if (identityExists()) {
    console.log('⚠️  هذا الجهاز مرتبط بالفعل. أوقف الوكيل وأعد الاقتران إذا أردت تغييره.');
    console.log('   (احذف agent-identity.json لإلغاء الربط)');
    process.exit(0);
  }

  if (existsSync(PENDING_FILE)) {
    console.log('ℹ️  يوجد مفتاح معلق بالفعل (keys-pending.json).');
    console.log('   شغّل: node pair.mjs  لإكمال الربط.');
    process.exit(0);
  }

  const { privateKeyBase64url, publicKeyBase64url } = generateKeyPair();

  await writeFile(
    PENDING_FILE,
    JSON.stringify({ privateKeyBase64url, publicKeyBase64url }, null, 2),
    'utf-8',
  );

  console.log('✅ تم توليد مفتاح Ed25519 جديد');
  console.log(`   المفتاح العام: ${publicKeyBase64url}`);
  console.log('');
  console.log('▶️  الخطوة التالية:  node pair.mjs');
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
