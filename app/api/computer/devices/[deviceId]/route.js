import {
  callComputerRpc,
  computerJson,
  isComputerUuid,
  requireComputerAccess,
} from '../../../../../lib/computer-api';

export const runtime = 'nodejs';

export async function DELETE(request, { params }) {
  const context = await requireComputerAccess(request);
  if (context.response) return context.response;

  const { access, service } = context;
  const { deviceId } = await params;

  if (!isComputerUuid(deviceId)) {
    return computerJson({ error: true, code: 'INVALID_DEVICE_ID', message: 'معرّف الجهاز غير صالح.' }, 400);
  }

  const { data, error } = await callComputerRpc(service, 'revoke_computer_device', {
    p_user_id: access.user.id,
    p_device_id: deviceId,
  });
  if (error) {
    return computerJson({ error: true, code: 'DEVICE_REVOKE_FAILED', message: 'تعذر إلغاء ربط الجهاز.' }, 503);
  }

  if (data?.outcome === 'not_found') {
    return computerJson({ error: true, code: 'DEVICE_NOT_FOUND', message: 'الجهاز غير موجود في حسابك.' }, 404);
  }
  if (data?.outcome === 'already_revoked') {
    return computerJson({ error: true, code: 'DEVICE_ALREADY_REVOKED', message: 'الجهاز ملغى الربط بالفعل.' }, 409);
  }
  if (data?.outcome !== 'revoked') {
    console.error('[Computer pairing] device revocation RPC returned an unexpected outcome');
    return computerJson({ error: true, code: 'DEVICE_REVOKE_FAILED', message: 'تعذر إلغاء ربط الجهاز.' }, 503);
  }

  return computerJson({ success: true });
}