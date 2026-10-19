import {
  callComputerRpc,
  computerJson,
  readComputerJson,
} from '../../../../../lib/computer-api';
import {
  createPairingChallenge,
  createPairingSecret,
  hashPairingClientIp,
  hashPairingSecret,
  validateComputerPublicKey,
} from '../../../../../lib/computer-pairing-crypto';
import { createServiceClient } from '../../../../../lib/whatsapp-cluster';

export const runtime = 'nodejs';

export async function POST(request) {
  const parsed = await readComputerJson(request);
  if (!parsed.ok) {
    const tooLarge = parsed.code === 'BODY_TOO_LARGE';
    return computerJson({
      error: true,
      code: parsed.code,
      message: tooLarge ? 'حجم الطلب أكبر من المسموح.' : 'صيغة الطلب غير صالحة.',
    }, tooLarge ? 413 : 400);
  }

  const body = parsed.value;
  if (
    Object.keys(body).some((key) => !['publicKey', 'deviceLabel'].includes(key)) ||
    !validateComputerPublicKey(body.publicKey) ||
    typeof body.deviceLabel !== 'string' ||
    body.deviceLabel.trim().length < 1 ||
    body.deviceLabel.trim().length > 64 ||
    /[\x00-\x1f]/.test(body.deviceLabel)
  ) {
    return computerJson({
      error: true,
      code: 'INVALID_PAIRING_REQUEST',
      message: 'بيانات الاقتران غير صالحة.',
    }, 400);
  }

  const service = createServiceClient();
  if (!service) {
    return computerJson({
      error: true,
      code: 'COMPUTER_SERVICE_UNAVAILABLE',
      message: 'خدمة ربط الكمبيوتر غير متاحة حاليًا.',
    }, 503);
  }

  const secret = createPairingSecret();
  const challenge = createPairingChallenge();
  const { data, error } = await callComputerRpc(service, 'create_computer_pairing_session', {
    p_token_hash: hashPairingSecret(secret),
    p_public_key: body.publicKey,
    p_challenge: challenge,
    p_label: body.deviceLabel.trim(),
    p_creator_ip_hash: hashPairingClientIp(request),
  });

  if (error) {
    return computerJson({
      error: true,
      code: 'PAIRING_SESSION_CREATE_FAILED',
      message: 'تعذر إنشاء جلسة الاقتران.',
    }, 503);
  }
  if (data?.outcome === 'rate_limited') {
    return computerJson({
      error: true,
      code: 'PAIRING_RATE_LIMITED',
      message: 'تجاوزت عدد محاولات الاقتران المسموح؛ حاول لاحقًا.',
    }, 429);
  }
  if (data?.outcome !== 'created' || !data.sessionId || !data.expiresAt) {
    console.error('[Computer pairing] session creation returned an unexpected outcome');
    return computerJson({
      error: true,
      code: 'PAIRING_SESSION_CREATE_FAILED',
      message: 'تعذر إنشاء جلسة الاقتران.',
    }, 503);
  }

  return computerJson({
    sessionId: data.sessionId,
    token: secret,
    expiresAt: data.expiresAt,
  }, 201);
}
