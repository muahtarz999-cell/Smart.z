import {
  callComputerRpc,
  computerJson,
  isComputerUuid,
  readComputerJson,
} from '../../../../../../../lib/computer-api';
import {
  hashPairingSecret,
  isValidPairingSecret,
} from '../../../../../../../lib/computer-pairing-crypto';
import { createServiceClient } from '../../../../../../../lib/whatsapp-cluster';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
  const { sessionId } = await params;
  if (!isComputerUuid(sessionId)) {
    return computerJson({ error: true, code: 'INVALID_SESSION_ID', message: 'معرّف الجلسة غير صالح.' }, 400);
  }

  const parsed = await readComputerJson(request);
  if (!parsed.ok || Object.keys(parsed.value || {}).some((key) => key !== 'token')
    || !isValidPairingSecret(parsed.value?.token)) {
    return computerJson({ error: true, code: 'INVALID_PAIRING_TOKEN', message: 'رمز الاقتران غير صالح.' }, 400);
  }

  const service = createServiceClient();
  if (!service) {
    return computerJson({ error: true, code: 'COMPUTER_SERVICE_UNAVAILABLE', message: 'الخدمة غير متاحة.' }, 503);
  }

  const { data, error } = await callComputerRpc(service, 'cancel_computer_pairing_session', {
    p_session_id: sessionId,
    p_token_hash: hashPairingSecret(parsed.value.token),
  });
  if (error) {
    return computerJson({ error: true, code: 'PAIRING_CANCEL_FAILED', message: 'تعذر إلغاء جلسة الاقتران.' }, 503);
  }
  if (data?.outcome === 'not_found') {
    return computerJson({ error: true, code: 'PAIRING_SESSION_NOT_FOUND', message: 'جلسة الاقتران غير موجودة.' }, 404);
  }
  if (!['cancelled', 'already_finished'].includes(data?.outcome)) {
    console.error('[Computer pairing] session cancellation returned an unexpected outcome');
    return computerJson({ error: true, code: 'PAIRING_CANCEL_FAILED', message: 'تعذر إلغاء جلسة الاقتران.' }, 503);
  }

  return computerJson({ success: true, outcome: data.outcome });
}
