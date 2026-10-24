import { json } from '../../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../lib/customer-access';
import { setWhatsAppReceptionist } from '../../../../lib/receptionist-store';
import { createServiceClient } from '../../../../lib/whatsapp-cluster';
import { businessConnection, setMetaCalling, sipServerConfig } from '../../../../lib/whatsapp-calling';

export const runtime = 'nodejs';

/**
 * Turns AI answering of WhatsApp calls on the Meta business number on or off.
 * Body: { enabled: boolean }. On: Meta enables calling and sends the calls by SIP
 * to WHATSAPP_CALLS_SIP_HOST; the number is routed to this customer's receptionist.
 */
export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const body = await request.json().catch(() => null);
  if (typeof body?.enabled !== 'boolean') {
    return json({ error: true, message: 'طلب غير صالح.' }, 400);
  }

  const service = createServiceClient();
  if (!service) {
    return json({ error: true, message: 'الخدمة غير متاحة حاليًا.' }, 503);
  }

  const connection = await businessConnection(service, access.user.id);
  if (!connection) {
    return json({
      error: true,
      message: 'اربط رقم الأعمال مع Meta أولًا من «ربط التطبيقات ← WhatsApp».',
    }, 409);
  }

  const server = sipServerConfig();
  if (body.enabled && (!server || !process.env.OPENAI_API_KEY)) {
    return json({
      error: true,
      message: 'خدمة الرد على مكالمات واتساب لم تُجهَّز بعد على الخادم (مزود SIP أو مفتاح OpenAI).',
    }, 503);
  }

  const meta = await setMetaCalling(connection, body.enabled, server)
    .catch(() => ({ ok: false, message: null }));

  if (!meta.ok) {
    const action = body.enabled ? 'تفعيل' : 'تعطيل';
    return json({
      error: true,
      message:
        `تعذر تأكيد ${action} المكالمات من Meta. لم يتغير الإعداد المحلي المحفوظ. ` +
        (meta.message ? `تفاصيل Meta: ${meta.message} ` : '') +
        'تحقق من حالة المكالمات في Meta ثم أعد المحاولة.',
    }, 502);
  }

  try {
    await setWhatsAppReceptionist(
      service,
      access.user.id,
      body.enabled,
      connection.number
    );
  } catch {
    return json({
      error: true,
      message:
        'تم تحديث حالة المكالمات في Meta، لكن تعذر حفظ الإعداد محليًا. ' +
        'قد تختلف الحالة في Meta عن الحالة المحفوظة في التطبيق. ' +
        'تحقق من الحالتين قبل إعادة المحاولة.',
    }, 503);
  }

  return json({
    success: true,
    enabled: body.enabled,
    number: connection.number,
  });
}
