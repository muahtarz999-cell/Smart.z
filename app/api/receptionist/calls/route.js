import { json } from '../../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../lib/customer-access';
import { listCallLogs } from '../../../../lib/receptionist-store';
import { createServiceClient } from '../../../../lib/whatsapp-cluster';

export const runtime = 'nodejs';

/** Calls the receptionist answered: summary, message, urgency. Newest first. */
export async function GET(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);
  const service = createServiceClient();
  if (!service) return json({ error: true, message: 'الخدمة غير متاحة حاليًا.' }, 503);
  try {
    return json({ calls: await listCallLogs(service, access.user.id) });
  } catch {
    return json({ error: true, message: 'تعذر جلب سجل المكالمات.' }, 503);
  }
}

/** Clears the whole log. */
export async function DELETE(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);
  const service = createServiceClient();
  if (!service) return json({ error: true, message: 'الخدمة غير متاحة حاليًا.' }, 503);
  const { error } = await service.from('ai_call_logs').delete().eq('user_id', access.user.id);
  if (error) return json({ error: true, message: 'تعذر مسح السجل.' }, 503);
  return json({ success: true });
}
