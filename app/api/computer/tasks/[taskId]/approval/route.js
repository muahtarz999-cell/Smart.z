import {
  callComputerRpc,
  computerJson,
  isComputerUuid,
  requireComputerAccess,
  readComputerJson,
} from '../../../../../../lib/computer-api';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
  const context = await requireComputerAccess(request);
  if (context.response) return context.response;

  const { access, service } = context;
  const { taskId } = await params;

  if (!isComputerUuid(taskId)) {
    return computerJson({
      error: true,
      code: 'INVALID_TASK_ID',
      message: 'معرّف المهمة غير صالح.',
    }, 400);
  }

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
  if (Object.keys(body).some((key) => key !== 'decision')) {
    return computerJson({ error: true, code: 'INVALID_REQUEST', message: 'تحتوي بيانات الطلب على حقول غير مسموحة.' }, 400);
  }
  const decision = body.decision;
  if (!['approved', 'rejected'].includes(decision)) {
    return computerJson({
      error: true,
      code: 'INVALID_DECISION',
      message: 'يجب اختيار الموافقة أو الرفض.',
    }, 400);
  }

  const { data, error } = await callComputerRpc(service, 'decide_computer_task_approval', {
    p_user_id: access.user.id,
    p_task_id: taskId,
    p_decision: decision,
  });
  if (error) {
    return computerJson({
      error: true,
      code: 'APPROVAL_UPDATE_FAILED',
      message: 'تعذر تسجيل قرار الموافقة.',
    }, 503);
  }

  if (data?.outcome === 'not_found') {
    return computerJson({ error: true, code: 'TASK_NOT_FOUND', message: 'المهمة غير موجودة في حسابك.' }, 404);
  }
  if (data?.outcome === 'expired') {
    return computerJson({ error: true, code: 'TASK_EXPIRED', message: 'انتهت صلاحية المهمة؛ أنشئ طلبًا جديدًا إذا لزم الأمر.' }, 410);
  }
  if (data?.outcome === 'device_not_active') {
    return computerJson({ error: true, code: 'DEVICE_NOT_ACTIVE', message: 'أُلغي ربط الجهاز؛ لا يمكن اعتماد المهمة.' }, 409);
  }
  if (data?.outcome === 'already_decided') {
    return computerJson({ error: true, code: 'APPROVAL_ALREADY_DECIDED', message: 'تم اتخاذ قرار بشأن هذه المهمة بالفعل.' }, 409);
  }
  if (data?.outcome !== 'decided' || !data.task?.id) {
    console.error('[Computer pairing] approval RPC returned an unexpected outcome');
    return computerJson({ error: true, code: 'APPROVAL_UPDATE_FAILED', message: 'تعذر تسجيل قرار الموافقة.' }, 503);
  }

  return computerJson({
    success: true,
    decision,
    task: data.task,
  });
}