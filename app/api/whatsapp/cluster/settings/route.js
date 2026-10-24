import { json } from '../../../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../../lib/customer-access';
import { cleanCallMessage, DRIVING_FLAG_MS } from '../../../../../lib/call-rules';


const SCOPES = new Set(['all', 'allowlist']);
const VOICE_MODES = new Set(['match', 'text', 'voice']);

// Reply rules of the personal WhatsApp path. Any subset of the fields may be sent.
export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const body = await request.json().catch(() => null);
  const changes = {};
  if (typeof body?.autoReply === 'boolean') changes.auto_reply_enabled = body.autoReply;
  if (SCOPES.has(body?.replyScope)) changes.reply_scope = body.replyScope;
  if (VOICE_MODES.has(body?.voiceReplyMode)) changes.voice_reply_mode = body.voiceReplyMode;
  if (Array.isArray(body?.allowedNumbers)) {
    changes.allowed_numbers = [...new Set(body.allowedNumbers
      .map((n) => String(n || '').replace(/\D/g, ''))
      .filter((n) => n.length >= 8 && n.length <= 15))].slice(0, 200);
  }
  // WhatsApp calls (2026-10-22): reject with a message; driving mode turns it on while it runs.
  if (typeof body?.callReject === 'boolean') changes.call_reject_enabled = body.callReject;
  if (typeof body?.callRejectMessage === 'string') changes.call_reject_message = cleanCallMessage(body.callRejectMessage) || null;
  if (typeof body?.driving === 'boolean') {
    changes.driving_until = body.driving ? new Date(Date.now() + DRIVING_FLAG_MS).toISOString() : null;
  }
  if (!Object.keys(changes).length) return json({ success: false, error: 'لا توجد إعدادات صالحة للحفظ.' }, 400);

  const { data, error } = await access.client
    .from('whatsapp_tenant_nodes')
    .update(changes)
    .eq('user_id', access.user.id)
    .select('*')
    .maybeSingle();
  if (error) return json({ success: false, error: 'تعذر حفظ الإعداد. تأكد من تطبيق آخر تحديث لقاعدة البيانات.' }, 503);
  if (!data) return json({ success: false, error: 'اربط WhatsApp أولاً.' }, 409);
  return json({
    success: true,
    autoReply: data.auto_reply_enabled === true,
    replyScope: data.reply_scope || 'all',
    allowedNumbers: data.allowed_numbers || [],
    voiceReplyMode: data.voice_reply_mode || 'match',
    callReject: data.call_reject_enabled === true,
    callRejectMessage: data.call_reject_message || '',
  });
}
