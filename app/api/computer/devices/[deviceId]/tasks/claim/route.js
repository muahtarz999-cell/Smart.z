import {
  authenticateComputerRequest,
  computerJson,
  isComputerUuid,
} from '../../../../../../../lib/computer-device-api';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
  const { deviceId } = await params;
  if (!isComputerUuid(deviceId)) {
    return computerJson({ error: true, code: 'INVALID_DEVICE_ID' }, 400);
  }

  const auth = await authenticateComputerRequest(request, deviceId);
  if (auth.response) return auth.response;

  const { data, error } = await auth.service.rpc('claim_computer_task', {
    p_device_id: deviceId,
  });
  if (error) {
    console.error('[Computer agent] task claim failed', { code: error.code || null });
    return computerJson({ error: true, code: 'TASK_CLAIM_FAILED' }, 503);
  }
  if (data?.outcome === 'device_not_active') {
    return computerJson({ error: true, code: 'DEVICE_NOT_ACTIVE' }, 403);
  }
  if (data?.outcome === 'task_expired') {
    return computerJson({ task: null });
  }
  if (data?.outcome === 'empty') return computerJson({ task: null });
  if (data?.outcome !== 'claimed' || !data.task?.id) {
    console.error('[Computer agent] task claim returned an unexpected outcome');
    return computerJson({ error: true, code: 'TASK_CLAIM_FAILED' }, 503);
  }

  return computerJson({ task: data.task });
}
