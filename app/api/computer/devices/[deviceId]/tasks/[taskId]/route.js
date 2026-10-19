import {
  authenticateComputerRequest,
  computerJson,
  isComputerUuid,
} from '../../../../../../../lib/computer-device-api';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  const { deviceId, taskId } = await params;
  if (!isComputerUuid(deviceId) || !isComputerUuid(taskId)) {
    return computerJson({ error: true, code: 'INVALID_ID' }, 400);
  }

  const auth = await authenticateComputerRequest(request, deviceId);
  if (auth.response) return auth.response;

  const { data, error } = await auth.service
    .from('computer_tasks')
    .select('id, status, expires_at')
    .eq('device_id', deviceId)
    .eq('id', taskId)
    .maybeSingle();
  if (error) {
    console.error('[Computer agent] task status lookup failed', { code: error.code || null });
    return computerJson({ error: true, code: 'TASK_STATUS_FAILED' }, 503);
  }
  if (!data) return computerJson({ error: true, code: 'TASK_NOT_FOUND' }, 404);

  return computerJson({ status: data.status, expiresAt: data.expires_at });
}
