import { json } from '../../../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../../lib/customer-access';

export const runtime = 'edge';

export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const body = await request.json().catch(() => null);
  if (typeof body?.autoReply !== 'boolean') return json({ success: false, error: 'autoReply must be true or false.' }, 400);

  const { data, error } = await access.client
    .from('whatsapp_tenant_nodes')
    .update({ auto_reply_enabled: body.autoReply })
    .eq('user_id', access.user.id)
    .select('auto_reply_enabled')
    .maybeSingle();
  if (error) return json({ success: false, error: 'تعذر حفظ الإعداد.' }, 503);
  if (!data) return json({ success: false, error: 'اربط WhatsApp أولاً.' }, 409);
  return json({ success: true, autoReply: data.auto_reply_enabled });
}
