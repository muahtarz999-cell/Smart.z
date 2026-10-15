/** Reply rules for the WhatsApp personal path (pure, shared by routes and tests). */

export function normalizeNumber(value) {
  return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

/** Decides whether this sender gets an automatic reply under the customer's rules. */
export function isReplyAllowed(tenant, senderNumber) {
  if (!tenant || tenant.auto_reply_enabled !== true) return false;
  if ((tenant.reply_scope || 'all') === 'all') return true;
  const number = normalizeNumber(senderNumber);
  return Boolean(number) && (tenant.allowed_numbers || []).some((allowed) => {
    const candidate = normalizeNumber(allowed);
    return candidate && (number === candidate || number.endsWith(candidate) || candidate.endsWith(number));
  });
}

export function wantsVoiceReply(tenant, incomingIsVoice) {
  const mode = tenant?.voice_reply_mode || 'match';
  return mode === 'voice' || (mode === 'match' && incomingIsVoice);
}
