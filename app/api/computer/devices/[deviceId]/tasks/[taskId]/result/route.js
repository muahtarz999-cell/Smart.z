import {
  authenticateComputerRequest,
  computerJson,
  isComputerUuid,
  readComputerJson,
} from '../../../../../../../../lib/computer-device-api';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
  const { deviceId, taskId } = await params;
  if (!isComputerUuid(deviceId) || !isComputerUuid(taskId)) {
    return computerJson({ error: true, code: 'INVALID_ID' }, 400);
  }

  const auth = await authenticateComputerRequest(request, deviceId);
  if (auth.response) return auth.response;

  const parsed = await readComputerJson(request);
  if (!parsed.ok) {
    return computerJson({ error: true, code: parsed.code }, parsed.code === 'BODY_TOO_LARGE' ? 413 : 400);
  }
  const { status, result } = parsed.value;
  if (
    Object.keys(parsed.value).some((key) => !['status', 'result'].includes(key)) ||
    !['succeeded', 'failed'].includes(status) ||
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    Buffer.byteLength(JSON.stringify(result), 'utf8') > 8192
  ) {
    return computerJson({ error: true, code: 'INVALID_TASK_RESULT' }, 400);
  }

  const { data, error } = await auth.service.rpc('report_computer_task_result', {
    p_device_id: deviceId,
    p_task_id: taskId,
    p_status: status,
    p_result: result,
  });
  if (error) {
    console.error('[Computer agent] task result update failed', { code: error.code || null });
    return computerJson({ error: true, code: 'TASK_RESULT_FAILED' }, 503);
  }
  if (data?.outcome === 'device_not_active') {
    return computerJson({ error: true, code: 'DEVICE_NOT_ACTIVE' }, 403);
  }
  if (data?.outcome === 'not_found') {
    return computerJson({ error: true, code: 'TASK_NOT_FOUND' }, 404);
  }
  if (data?.outcome === 'already_finished') {
    return computerJson({ error: true, code: 'TASK_ALREADY_FINISHED' }, 409);
  }
  if (data?.outcome !== 'reported') {
    console.error('[Computer agent] task result RPC returned an unexpected outcome');
    return computerJson({ error: true, code: 'TASK_RESULT_FAILED' }, 503);
  }

  return computerJson({ success: true, status });
}
