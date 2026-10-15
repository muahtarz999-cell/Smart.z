import { json } from '../../../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../../lib/customer-access';
import { callNode, getClusterNode, getUserAssignment } from '../../../../../lib/whatsapp-cluster';
import { MAX_RECIPIENTS_WITHOUT_MANUAL_CONFIRMATION } from '../../../../../lib/whatsapp-commands';

export const runtime = 'edge';

const JID = /^[\w.:-]+@(s\.whatsapp\.net|g\.us|lid)$/;

// Executes a send the user commanded (after the app's undo window or manual confirmation).
export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const body = await request.json().catch(() => null);
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 4000) : '';
  const recipients = (Array.isArray(body?.recipients) ? body.recipients : [])
    .filter((r) => typeof r?.jid === 'string' && JID.test(r.jid)).slice(0, 50);
  if (!text || !recipients.length) return json({ success: false, error: 'نص الرسالة أو المستلمون غير صالحين.' }, 400);

  const individuals = recipients.filter((r) => !r.jid.endsWith('@g.us')).length;
  if (individuals > MAX_RECIPIENTS_WITHOUT_MANUAL_CONFIRMATION && body.manualConfirmation !== true) {
    return json({ success: false, code: 'MANUAL_CONFIRMATION_REQUIRED', error: 'الإرسال لأكثر من 5 أشخاص يحتاج تأكيداً يدوياً.' }, 409);
  }

  const assignment = await getUserAssignment(access.user.id, access.client).catch(() => null);
  const node = assignment ? getClusterNode(assignment.node_id) : null;
  if (!node) return json({ success: false, code: 'NOT_LINKED', error: 'اربط واتساب الشخصي أولاً.' }, 409);

  const results = [];
  for (const recipient of recipients) {
    try {
      const result = await callNode(node, '/api/send', { method: 'POST', body: { remoteJid: recipient.jid, text }, timeoutMs: 20_000 });
      results.push({ jid: recipient.jid, ok: result.ok, error: result.ok ? undefined : result.data?.error });
    } catch {
      results.push({ jid: recipient.jid, ok: false, error: 'NODE_UNREACHABLE' });
    }
  }
  const sent = results.filter((r) => r.ok).length;
  return json({ success: sent === results.length, sent, failed: results.length - sent, results }, sent ? 200 : 502);
}
