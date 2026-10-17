import { json } from '../../../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../../lib/customer-access';
import { callNode, getClusterNode, getUserAssignment } from '../../../../../lib/whatsapp-cluster';
import { MAX_RECIPIENTS_WITHOUT_MANUAL_CONFIRMATION } from '../../../../../lib/whatsapp-commands';
import { synthesizeWithFallback } from '../../../../../lib/cloud-tts';
import { bytesToBase64, textForSpeech } from '../../../../../lib/drive-turn';
import { splitForSpeech } from '../../../../../lib/text-chunks';

/** The message read by the cloud voice: [{ data(base64) }] for the node to join into one voice note, or null. */
async function voiceNoteParts(text, voice = {}) {
  const chunks = splitForSpeech(textForSpeech(text), 180);
  if (!chunks.length) return null;
  const options = {
    provider: typeof voice?.provider === 'string' && voice.provider !== 'auto' ? voice.provider : undefined,
    voices: voice?.voices && typeof voice.voices === 'object' ? voice.voices : {},
  };
  const parts = [];
  for (const chunk of chunks) {
    const result = await synthesizeWithFallback(chunk, options).catch(() => null);
    if (!result?.audio) return null;
    parts.push({ data: bytesToBase64(result.audio) });
  }
  return parts;
}

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
  const document = body?.document && typeof body.document.data === 'string' && body.document.data.length <= 7_000_000
    ? {
      data: body.document.data,
      fileName: String(body.document.fileName || 'مستند.docx').slice(0, 120),
      mimetype: String(body.document.mimetype || 'application/octet-stream').slice(0, 120),
    }
    : null;
  if ((!text && !document) || !recipients.length) return json({ success: false, error: 'نص الرسالة أو المستلمون غير صالحين.' }, 400);

  const individuals = recipients.filter((r) => !r.jid.endsWith('@g.us')).length;
  if (individuals > MAX_RECIPIENTS_WITHOUT_MANUAL_CONFIRMATION && body.manualConfirmation !== true) {
    return json({ success: false, code: 'MANUAL_CONFIRMATION_REQUIRED', error: 'الإرسال لأكثر من 5 أشخاص يحتاج تأكيداً يدوياً.' }, 409);
  }

  const assignment = await getUserAssignment(access.user.id, access.client).catch(() => null);
  const node = assignment ? getClusterNode(assignment.node_id) : null;
  if (!node) return json({ success: false, code: 'NOT_LINKED', error: 'اربط واتساب الشخصي أولاً.' }, 409);

  // Voice message: spoken once, the same note goes to every recipient. If no voice answers, the text goes instead.
  const voice = body.asVoice === true && text && !document ? await voiceNoteParts(text, body.voice) : null;

  const results = [];
  for (const recipient of recipients) {
    try {
      const result = await callNode(node, '/api/send', {
        method: 'POST',
        body: { remoteJid: recipient.jid, text, document, voice: voice || undefined },
        timeoutMs: 45_000,
      });
      results.push({ jid: recipient.jid, ok: result.ok, error: result.ok ? undefined : result.data?.error });
    } catch {
      results.push({ jid: recipient.jid, ok: false, error: 'NODE_UNREACHABLE' });
    }
  }
  const sent = results.filter((r) => r.ok).length;
  return json({
    success: sent === results.length, sent, failed: results.length - sent, results,
    voiceFallback: body.asVoice === true && !voice, // asked for voice, sent as text
  }, sent ? 200 : 502);
}
