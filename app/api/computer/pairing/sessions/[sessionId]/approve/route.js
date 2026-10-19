import {
  callComputerRpc,
  computerJson,
  requireComputerAccess,
  isComputerUuid,
  readComputerJson,
} from '../../../../../../../lib/computer-api';
import {
  hashPairingSecret,
  isValidPairingSecret,
} from '../../../../../../../lib/computer-pairing-crypto';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
  const context = await requireComputerAccess(request);
  if (context.response) return context.response;

  const { sessionId } = await params;
  if (!isComputerUuid(sessionId)) {
    return computerJson({ error: true, code: 'INVALID_SESSION_ID', message: 'معرّف الجلسة غير صالح.' }, 400);
  }

  const parsed = await readComputerJson(request);
  if (!parsed.ok || Object.keys(parsed.value || {}).some(
    (key) => !['token', 'action', 'replaceExisting'].includes(key)
  )) {
    return computerJson({ error: true, code: 'INVALID_REQUEST', message: 'بيانات الطلب غير صالحة.' }, 400);
  }

  const { token, action, replaceExisting } = parsed.value;
  if (
    !isValidPairingSecret(token) ||
    !['approve', 'reject'].includes(action) ||
    typeof replaceExisting !== 'boolean' ||
    (action === 'reject' && replaceExisting)
  ) {
    return computerJson({ error: true, code: 'INVALID_REQUEST', message: 'بيانات القرار غير صالحة.' }, 400);
  }

  const { data, error } = await callComputerRpc(context.service, 'decide_computer_pairing_session', {
    p_session_id: sessionId,
    p_token_hash: hashPairingSecret(token),
    p_user_id: context.access.user.id,
    p_decision: action,
    p_replace_existing: replaceExisting,
  });
  if (error) {
    return computerJson({ error: true, code: 'PAIRING_DECISION_FAILED', message: 'تعذر تسجيل قرار الاقتران.' }, 503);
  }

  if (data?.outcome === 'not_allowed') {
    return computerJson({ error: true, code: 'COMPUTER_PAIRING_NOT_ALLOWED', message: 'ربط الكمبيوتر غير مسموح لهذا الحساب.' }, 403);
  }
  if (data?.outcome === 'not_found') {
    return computerJson({ error: true, code: 'PAIRING_SESSION_NOT_FOUND', message: 'جلسة الاقتران غير موجودة.' }, 404);
  }
  if (data?.outcome === 'expired') {
    return computerJson({ error: true, code: 'PAIRING_SESSION_EXPIRED', message: 'انتهت صلاحية رمز الاقتران.' }, 410);
  }
  if (data?.outcome === 'replacement_required') {
    return computerJson({
      error: true,
      code: 'REPLACEMENT_CONFIRMATION_REQUIRED',
      message: 'يوجد كمبيوتر نشط على الحساب. أكد استبداله صراحةً للمتابعة.',
      activeDeviceLabel: data.activeDeviceLabel,
    }, 409);
  }
  if (data?.outcome === 'already_decided') {
    return computerJson({ error: true, code: 'PAIRING_ALREADY_DECIDED', message: 'اتُخذ قرار سابق بشأن هذه الجلسة.' }, 409);
  }
  if (!['approved', 'rejected'].includes(data?.outcome)) {
    console.error('[Computer pairing] session decision returned an unexpected outcome');
    return computerJson({ error: true, code: 'PAIRING_DECISION_FAILED', message: 'تعذر تسجيل قرار الاقتران.' }, 503);
  }

  return computerJson({ success: true, outcome: data.outcome });
}
