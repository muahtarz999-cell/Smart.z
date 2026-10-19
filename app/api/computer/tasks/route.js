import {
  callComputerRpc,
  computerJson,
  isComputerUuid,
  requireComputerAccess,
  readComputerJson,
  validateComputerTask,
} from '../../../../lib/computer-api';

export const runtime = 'nodejs';

export async function GET(request) {
  const context = await requireComputerAccess(request);
  if (context.response) return context.response;

  const { access, service } = context;
  const { data, error } = await service
    .from('computer_tasks')
    .select('id, device_id, task_type, status, payload, result, expires_at, created_at, updated_at')
    .eq('user_id', access.user.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    return computerJson({ error: true, code: 'TASK_LIST_FAILED', message: 'تعذر جلب المهام.' }, 503);
  }

  return computerJson({ tasks: data || [] });
}

export async function POST(request) {
  const context = await requireComputerAccess(request);
  if (context.response) return context.response;

  const { access, service } = context;
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
  if (Object.keys(body).some((key) => !['deviceId', 'taskType', 'payload'].includes(key))) {
    return computerJson({ error: true, code: 'INVALID_REQUEST', message: 'تحتوي بيانات الطلب على حقول غير مسموحة.' }, 400);
  }
  const deviceId = body?.deviceId;
  const taskType = body?.taskType;
  const payload = body?.payload;

  if (!isComputerUuid(deviceId)) {
    return computerJson({ error: true, code: 'INVALID_DEVICE_ID', message: 'معرّف الجهاز غير صالح.' }, 400);
  }

  const validationError = validateComputerTask(taskType, payload);
  if (validationError) {
    return computerJson({ error: true, code: 'INVALID_TASK', message: validationError }, 400);
  }

  const { data, error } = await callComputerRpc(service, 'create_computer_task_with_approval', {
    p_user_id: access.user.id,
    p_device_id: deviceId,
    p_task_type: taskType,
    p_payload: payload,
  });
  if (error) {
    return computerJson({ error: true, code: 'TASK_CREATE_FAILED', message: 'تعذر إنشاء المهمة.' }, 503);
  }
  if (data?.outcome === 'not_allowed') {
    return computerJson({ error: true, code: 'COMPUTER_PAIRING_NOT_ALLOWED', message: 'ربط الكمبيوتر غير مسموح لهذا الحساب حاليًا.' }, 403);
  }
  if (data?.outcome === 'device_not_active') {
    return computerJson({ error: true, code: 'DEVICE_NOT_ACTIVE', message: 'الجهاز غير مربوط أو غير نشط.' }, 403);
  }
  if (data?.outcome !== 'created' || !data.task?.id) {
    console.error('[Computer pairing] task creation RPC returned an unexpected outcome');
    return computerJson({ error: true, code: 'TASK_CREATE_FAILED', message: 'تعذر إنشاء المهمة.' }, 503);
  }

  return computerJson({ task: data.task }, 201);
}