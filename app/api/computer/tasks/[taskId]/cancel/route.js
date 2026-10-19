import {
  callComputerRpc,
  computerJson,
  isComputerUuid,
  requireComputerAccess,
} from '../../../../../../lib/computer-api';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
  const context = await requireComputerAccess(request);
  if (context.response) return context.response;

  const { taskId } = await params;
  if (!isComputerUuid(taskId)) {
    return computerJson({ error: true, code: 'INVALID_TASK_ID' }, 400);
  }

  const { data, error } = await callComputerRpc(context.service, 'cancel_computer_task', {
    p_user_id: context.access.user.id,
    p_task_id: taskId,
  });
  if (error) {
    return computerJson({ error: true, code: 'TASK_CANCEL_FAILED', message: 'تعذر إلغاء المهمة.' }, 503);
  }
  if (data?.outcome === 'not_found') {
    return computerJson({ error: true, code: 'TASK_NOT_FOUND', message: 'المهمة غير موجودة في حسابك.' }, 404);
  }
  if (data?.outcome === 'already_finished') {
    return computerJson({ error: true, code: 'TASK_ALREADY_FINISHED', message: 'المهمة منتهية بالفعل.' }, 409);
  }
  if (data?.outcome !== 'cancelled') {
    console.error('[Computer agent] task cancellation returned an unexpected outcome');
    return computerJson({ error: true, code: 'TASK_CANCEL_FAILED', message: 'تعذر إلغاء المهمة.' }, 503);
  }

  return computerJson({ success: true, status: 'cancelled' });
}
