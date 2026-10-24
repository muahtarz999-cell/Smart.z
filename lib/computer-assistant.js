// Server side of "ask the computer" from the assistant: finds the user's active
// paired computer and creates a task that waits for approval on the phone.
import { computerAccessFailure } from './computer-task-validation.mjs';
import { createServiceClient } from './whatsapp-cluster';

/** The active paired computer { id, label } when the account may use one, else null. Never throws. */
export async function activeComputerDevice(access) {
  if (computerAccessFailure(access)) return null;
  const service = createServiceClient();
  if (!service) return null;
  try {
    const { data, error } = await service
      .from('computer_devices')
      .select('id, label')
      .eq('user_id', access.user.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return error || !data?.id ? null : { id: data.id, label: data.label || 'الكمبيوتر' };
  } catch {
    return null;
  }
}

/** Creates the task (status awaiting_approval). Returns { ok, task } or { ok: false, message }. */
export async function createComputerTaskForUser(access, deviceId, taskType, payload) {
  const service = createServiceClient();
  if (!service) return { ok: false, message: 'خدمة ربط الكمبيوتر غير متاحة حاليًا.' };
  let data;
  let error;
  try {
    ({ data, error } = await service.rpc('create_computer_task_with_approval', {
      p_user_id: access.user.id,
      p_device_id: deviceId,
      p_task_type: taskType,
      p_payload: payload,
    }));
  } catch (exception) {
    error = exception;
  }
  if (error) {
    console.error('[Assistant computer] task creation failed', { code: error?.code || null });
    return { ok: false, message: 'تعذر إرسال المهمة إلى الكمبيوتر الآن.' };
  }
  if (data?.outcome === 'not_allowed') return { ok: false, message: 'ربط الكمبيوتر غير مسموح لهذا الحساب حاليًا.' };
  if (data?.outcome === 'device_not_active') return { ok: false, message: 'الكمبيوتر غير مربوط أو غير نشط.' };
  if (data?.outcome !== 'created' || !data.task?.id) return { ok: false, message: 'تعذر إرسال المهمة إلى الكمبيوتر الآن.' };
  return { ok: true, task: data.task };
}
