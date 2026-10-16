/**
 * Turns a send_whatsapp_message tool call into an action the app executes.
 *
 * Owner's rules (2026-10-15):
 *   - A clear command is executed without confirmation (the app gives an undo window).
 *   - Ask only when the recipient is ambiguous or unknown.
 *   - Groups only when the user named a group explicitly (to_group).
 *   - More than 5 individual recipients needs a manual tap to confirm, never voice.
 */
import { callNode, getClusterNode, getUserAssignment } from './whatsapp-cluster.js';

export const MAX_RECIPIENTS_WITHOUT_MANUAL_CONFIRMATION = 5;
const MAX_RECIPIENTS = 50;

function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join('، ')} و${names.at(-1)}`;
}

/**
 * search(name, { groups }) -> Promise<[{ jid, name, isGroup }]>
 * Returns { reply, action? }.
 */
export async function planSendCommand(args, search) {
  const text = typeof args?.message === 'string' ? args.message.trim().slice(0, 4000) : '';
  const names = (Array.isArray(args?.recipients) ? args.recipients : [])
    .map((name) => String(name || '').trim()).filter(Boolean).slice(0, MAX_RECIPIENTS);
  const toGroup = args?.to_group === true;

  const attachDocument = typeof args?.attach_document === 'string' && args.attach_document.trim()
    ? args.attach_document.trim().slice(0, 120) : null;
  if (!text && !attachDocument) return { reply: 'وش تبي أكتب في الرسالة؟' };
  if (!names.length) return { reply: 'لمن أرسل الرسالة؟' };

  const recipients = [];
  for (const name of names) {
    const matches = await search(name, { groups: toGroup });
    if (!matches.length) {
      return {
        reply: toGroup
          ? `ما لقيت مجموعة باسم «${name}» في واتساب.`
          : `ما لقيت «${name}» في محادثات واتساب. قل اسمه كما هو محفوظ عندك أو رقمه.`,
      };
    }
    if (matches.length > 1) {
      return { reply: `عندك أكثر من «${name}»: ${joinNames(matches.map((m) => m.name))}. لمن أرسل؟` };
    }
    if (!recipients.some((r) => r.jid === matches[0].jid)) recipients.push(matches[0]);
  }

  const individuals = recipients.filter((r) => !r.isGroup).length;
  const requiresManualConfirmation = individuals > MAX_RECIPIENTS_WITHOUT_MANUAL_CONFIRMATION;
  const label = joinNames(recipients.map((r) => (r.isGroup ? `مجموعة ${r.name}` : r.name)));
  return {
    reply: requiresManualConfirmation
      ? `الرسالة جاهزة إلى ${individuals} أشخاص. الإرسال الجماعي يحتاج ضغطة «تأكيد الإرسال» على الشاشة.`
      : `تم، أرسلت ${attachDocument ? 'المستند ' : ''}إلى ${label}.`,
    action: {
      type: 'whatsapp_send',
      recipients: recipients.map(({ jid, name, isGroup }) => ({ jid, name, isGroup: Boolean(isGroup) })),
      text,
      attachDocument, // resolved on the device from "مستنداتي" when the send executes
      requiresManualConfirmation,
    },
  };
}

export function nodeContactSearch(node) {
  return async (name, { groups }) => {
    const result = await callNode(node, '/api/contacts/search', { query: { q: name, groups: groups ? '1' : '0' }, timeoutMs: 10_000 });
    return result.ok && Array.isArray(result.data?.matches) ? result.data.matches : [];
  };
}

/** The personal WhatsApp node of this customer when linked (enables voice send commands), else null. */
export async function linkedWhatsAppNode(access) {
  try {
    const assignment = await getUserAssignment(access.user.id, access.client);
    return assignment?.status === 'connected' ? getClusterNode(assignment.node_id) : null;
  } catch {
    return null;
  }
}
