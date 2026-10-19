import {
  callComputerRpc,
  computerJson,
  isComputerUuid,
  readComputerJson,
} from '../../../../../../../lib/computer-api';
import {
  hashPairingSecret,
  isValidPairingSecret,
  verifyComputerPairingProof,
} from '../../../../../../../lib/computer-pairing-crypto';
import { createServiceClient } from '../../../../../../../lib/whatsapp-cluster';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
  const { sessionId } = await params;
  if (!isComputerUuid(sessionId)) {
    return computerJson({ error: true, code: 'INVALID_SESSION_ID', message: 'معرّف الجلسة غير صالح.' }, 400);
  }

  const parsed = await readComputerJson(request);
  if (!parsed.ok || Object.keys(parsed.value || {}).some(
    (key) => !['token', 'signature'].includes(key)
  )) {
    return computerJson({ error: true, code: 'INVALID_REQUEST', message: 'بيانات إثبات المفتاح غير صالحة.' }, 400);
  }

  const { token, signature } = parsed.value;
  if (!isValidPairingSecret(token) || typeof signature !== 'string') {
    return computerJson({ error: true, code: 'INVALID_PROOF', message: 'إثبات امتلاك المفتاح غير صالح.' }, 400);
  }

  const service = createServiceClient();
  if (!service) {
    return computerJson({ error: true, code: 'COMPUTER_SERVICE_UNAVAILABLE', message: 'الخدمة غير متاحة.' }, 503);
  }

  const tokenHash = hashPairingSecret(token);
  const { data: session, error: lookupError } = await service
    .from('computer_pairing_sessions')
    .select('public_key, challenge, status, expires_at')
    .eq('id', sessionId)
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (lookupError) {
    console.error('[Computer pairing] proof lookup failed', { code: lookupError.code || null });
    return computerJson({ error: true, code: 'PAIRING_PROOF_FAILED', message: 'تعذر التحقق من إثبات المفتاح.' }, 503);
  }
  if (!session) {
    return computerJson({ error: true, code: 'PAIRING_SESSION_NOT_FOUND', message: 'جلسة الاقتران غير موجودة.' }, 404);
  }
  if (session.status === 'completed') {
    const { data, error } = await callComputerRpc(service, 'get_computer_pairing_session_status', {
      p_session_id: sessionId,
      p_token_hash: tokenHash,
    });
    if (error || data?.status !== 'completed' || !data.deviceId) {
      return computerJson({ error: true, code: 'PAIRING_COMPLETION_FAILED', message: 'تعذر التحقق من اكتمال الاقتران.' }, 503);
    }
    return computerJson({ success: true, deviceId: data.deviceId });
  }
  if (session.status !== 'approved') {
    return computerJson({ error: true, code: 'PAIRING_NOT_APPROVED', message: 'لم يوافق المستخدم على الاقتران بعد.' }, 409);
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    return computerJson({ error: true, code: 'PAIRING_SESSION_EXPIRED', message: 'انتهت صلاحية جلسة الاقتران.' }, 410);
  }

  const proofVerified = verifyComputerPairingProof(
    session.public_key,
    sessionId,
    session.challenge,
    signature,
  );
  if (!proofVerified) {
    return computerJson({ error: true, code: 'INVALID_PROOF', message: 'تعذر إثبات امتلاك المفتاح الخاص.' }, 401);
  }

  const { data, error } = await callComputerRpc(service, 'complete_computer_pairing_session', {
    p_session_id: sessionId,
    p_token_hash: tokenHash,
    p_proof_verified: true,
  });
  if (error) {
    return computerJson({ error: true, code: 'PAIRING_COMPLETION_FAILED', message: 'تعذر إكمال الاقتران.' }, 503);
  }
  if (data?.outcome === 'replacement_required') {
    return computerJson({
      error: true,
      code: 'REPLACEMENT_CONFIRMATION_REQUIRED',
      message: 'أصبح هناك كمبيوتر نشط آخر. امسح الرمز مجددًا وأكد الاستبدال.',
    }, 409);
  }
  if (data?.outcome === 'expired') {
    return computerJson({ error: true, code: 'PAIRING_SESSION_EXPIRED', message: 'انتهت صلاحية جلسة الاقتران.' }, 410);
  }
  if (data?.outcome === 'not_allowed') {
    return computerJson({ error: true, code: 'COMPUTER_PAIRING_NOT_ALLOWED', message: 'لم يعد هذا الحساب مخولًا لربط الكمبيوتر.' }, 403);
  }
  if (!['paired', 'completed'].includes(data?.outcome) || !data.deviceId) {
    return computerJson({ error: true, code: 'PAIRING_COMPLETION_FAILED', message: 'تعذر إكمال الاقتران.' }, 409);
  }

  return computerJson({ success: true, deviceId: data.deviceId });
}
