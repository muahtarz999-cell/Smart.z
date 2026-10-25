/**
 * Smart.z Windows Agent – pairing with Terminal QR Code (Requirement 2)
 */

import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { signPairingProof } from './crypto.mjs';
import { identityExists, saveIdentity, IDENTITY_FILE } from './identity.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const PENDING_FILE = join(DIR, 'keys-pending.json');

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return (i !== -1 && i + 1 < args.length) ? args[i + 1] : null;
}
const DEFAULT_URL = 'https://smart-z.muahtarz999.workers.dev';
const BASE_URL = (argValue('--url') ?? process.env.SMARTZ_URL ?? DEFAULT_URL).replace(/\/$/, '');
const DEVICE_LABEL = (argValue('--label') ?? 'Windows computer').trim();

async function api(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function renderTerminalQr(sessionId, token, expiresAt) {
  // نفس صيغة QR التي يعرضها المتصفح، وهي التي يتحقق منها تطبيق الهاتف بالضبط
  // (المفاتيح والترتيب والـ origin يجب أن تطابق عنوان الموقع الذي يفتحه الهاتف).
  const pairingUrl = JSON.stringify({
    version: 1,
    origin: new URL(BASE_URL).origin,
    sessionId,
    token,
  });
  const expires = new Date(expiresAt).toLocaleTimeString();

  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  Smart.z – ربط جهاز Windows (امسح رمز الاستجابة السريعة QR)');
  console.log('════════════════════════════════════════════════════════════');
  console.log('');

  qrcode.generate(pairingUrl, { small: true }, (qr) => {
    console.log(qr);
  });

  console.log('');
  console.log('  بديل يدوي: الصق النص التالي في خانة «الصق محتوى QR» بالهاتف:');
  console.log(`  ${pairingUrl}`);
  console.log(`  معرّف الجلسة: ${sessionId}`);
  console.log(`  رمز التحقق:  ${token}`);
  console.log(`  تنتهي الصلاحية: ${expires}`);
  console.log('════════════════════════════════════════════════════════════');
  console.log('  ⏳ في انتظار موافقة التطبيق على الهاتف ...');
}

async function main() {
  if (identityExists()) {
    console.log('⚠️  الجهاز مرتبط بالفعل (الهوية المشفرة موجودة).');
    console.log(`   ${IDENTITY_FILE}`);
    process.exit(0);
  }

  if (!existsSync(PENDING_FILE)) {
    console.error('❌ لا يوجد مفتاح معلق. شغّل أولاً:  node keygen.mjs');
    process.exit(1);
  }

  const { privateKeyBase64url, publicKeyBase64url } = JSON.parse(
    await readFile(PENDING_FILE, 'utf-8'),
  );

  console.log(`🔗 الاتصال بـ Smart.z (${BASE_URL}) ...`);

  const createRes = await api('/api/computer/pairing/sessions', {
    publicKey: publicKeyBase64url,
    deviceLabel: DEVICE_LABEL,
  });

  if (createRes.status === 429) {
    console.error('❌ تجاوزت عدد محاولات الاقتران المسموح؛ حاول لاحقًا.');
    process.exit(1);
  }
  if (createRes.status !== 201 || !createRes.json.sessionId) {
    console.error('❌ فشل إنشاء جلسة الاقتران:', createRes.json);
    process.exit(1);
  }

  const { sessionId, token, expiresAt } = createRes.json;
  const expiresMs = new Date(expiresAt).getTime();

  renderTerminalQr(sessionId, token, expiresAt);

  let challenge = null;

  while (Date.now() < expiresMs - 2000) {
    await sleep(3000);
    const { status, json } = await api(
      `/api/computer/pairing/sessions/${sessionId}/status`,
      { token },
    );

    if (status !== 200) {
      console.error('\n❌ فشل الاستعلام عن حالة الجلسة:', json);
      process.exit(1);
    }

    if (json.status === 'approved') {
      challenge = json.challenge;
      console.log('\n✅ وافق الهاتف على الاقتران! جارٍ إثبات المفتاح وإكماله ...');
      break;
    }
    if (json.status === 'rejected') {
      console.error('\n❌ رفض الهاتف طلب الاقتران.');
      process.exit(1);
    }
    if (json.status === 'expired') {
      console.error('\n❌ انتهت صلاحية جلسة الاقتران.');
      process.exit(1);
    }
    process.stdout.write('.');
  }

  if (!challenge) {
    console.error('\n❌ انتهت المهلة دون موافقة.');
    await api(`/api/computer/pairing/sessions/${sessionId}/cancel`, { token }).catch(() => {});
    process.exit(1);
  }

  const signature = signPairingProof(privateKeyBase64url, sessionId, challenge);
  const completeRes = await api(`/api/computer/pairing/sessions/${sessionId}/complete`, {
    token,
    signature,
  });

  if (completeRes.status !== 200 || !completeRes.json.deviceId) {
    console.error('❌ فشل إكمال الاقتران:', completeRes.json);
    process.exit(1);
  }

  const { deviceId } = completeRes.json;

  await saveIdentity({
    privateKeyBase64url,
    publicKeyBase64url,
    deviceId,
    deviceLabel: DEVICE_LABEL,
    baseUrl: BASE_URL,
    pairedAt: new Date().toISOString(),
  });
  await rm(PENDING_FILE, { force: true });

  console.log('');
  console.log('🎉 اكتمل ربط جهاز Windows بنجاح وتم حفظ الهوية مشفرة!');
  console.log(`   Device ID : ${deviceId}`);
  console.log(`   ملف الهوية : ${IDENTITY_FILE}`);
  console.log('');
  console.log('▶️  شغّل الوكيل:  node agent.mjs (أو start-agent.bat)');
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});

