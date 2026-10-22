import { json } from '../../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../lib/customer-access';
import { sanitizeReceptionistSettings } from '../../../../lib/receptionist';
import { listReceptionistNumbers, loadReceptionistSettings, saveReceptionistSettings } from '../../../../lib/receptionist-store';
import { createServiceClient } from '../../../../lib/whatsapp-cluster';

export const runtime = 'nodejs';

async function context(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return { response: customerAccessResponse(access) };
  const service = createServiceClient();
  if (!service) return { response: json({ error: true, message: 'الخدمة غير متاحة حاليًا.' }, 503) };
  return { access, service };
}

async function snapshot(service, userId) {
  const [settings, numbers] = await Promise.all([loadReceptionistSettings(service, userId), listReceptionistNumbers(service, userId)]);
  return {
    settings,
    phoneNumbers: numbers.filter((row) => row.channel === 'phone').map((row) => row.number),
    whatsappNumber: numbers.find((row) => row.channel === 'whatsapp')?.number || null,
    configured: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_WEBHOOK_SECRET),
  };
}

/** The receptionist settings, the numbers routed to this customer, and whether the service is set up. */
export async function GET(request) {
  const ctx = await context(request);
  if (ctx.response) return ctx.response;
  try {
    return json(await snapshot(ctx.service, ctx.access.user.id));
  } catch {
    return json({ error: true, message: 'تعذر جلب إعدادات موظف الاستقبال. تأكد من تطبيق آخر تحديث لقاعدة البيانات.' }, 503);
  }
}

export async function POST(request) {
  const ctx = await context(request);
  if (ctx.response) return ctx.response;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: true, message: 'طلب غير صالح.' }, 400);
  try {
    const current = await loadReceptionistSettings(ctx.service, ctx.access.user.id);
    const next = sanitizeReceptionistSettings({ ...current, ...body });
    await saveReceptionistSettings(ctx.service, ctx.access.user.id, next);
    return json(await snapshot(ctx.service, ctx.access.user.id));
  } catch {
    return json({ error: true, message: 'تعذر حفظ الإعدادات.' }, 503);
  }
}
