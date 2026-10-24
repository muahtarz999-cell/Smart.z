/**
 * Call assistant rules (owner request 2026-10-22). Pure, shared by routes and tests.
 *
 *   Phone calls (Android): announce the caller; answer / reject / reject with a
 *   message by voice in driving mode or from the notification buttons.
 *   WhatsApp calls (node): reject automatically and send a message.
 *
 * Both are switched on by the user, and are always on while driving mode runs.
 */
import { normalizeArabic } from './arabic-normalize.js';

export const DEFAULT_CALL_MESSAGE = 'مشغول الآن، سأتواصل معك لاحقًا.';
export const DRIVING_CALL_MESSAGE = 'أنا أسوق الآن، سأتواصل معك لاحقًا.';
export const MAX_CALL_MESSAGE = 300;
/** Driving mode marks itself on the server for this long; a crash cannot leave it on forever. */
export const DRIVING_FLAG_MS = 4 * 60 * 60 * 1000;

export function cleanCallMessage(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, MAX_CALL_MESSAGE) : '';
}

export function isDrivingFlagActive(drivingUntil, now = Date.now()) {
  const until = Date.parse(drivingUntil || '');
  return Number.isFinite(until) && until > now;
}

/**
 * Should the node reject this WhatsApp call, and with which message?
 * tenant: whatsapp_tenant_nodes row. Returns { reject, message }.
 */
export function decideWhatsAppCall(tenant, now = Date.now()) {
  const driving = isDrivingFlagActive(tenant?.driving_until, now);
  if (!driving && tenant?.call_reject_enabled !== true) return { reject: false, message: null };
  const custom = cleanCallMessage(tenant?.call_reject_message);
  return { reject: true, message: driving ? DRIVING_CALL_MESSAGE : (custom || DEFAULT_CALL_MESSAGE) };
}

// ---------------------------------------------------------------- voice commands while a call rings

const ANSWER = /^(?:(?:نعم|ايوه|ايه|اي|طيب|اوكي|ok)\s+)?(?:رد|ردي|رد عليه|رد عليها|رد على المكالمه|افتح الخط|افتح المكالمه|اقبل|اقبل المكالمه|استقبل|استقبلها|جاوب|جاوبه|جاوبها)$/;
const REJECT = /^(?:لا\s+)?(?:ارفض|ارفضها|ارفضه|رفض|سكر|سكرها|سكر عليه|اقفل|اقفلها|اقفل الخط|كنسل|كنسلها|طنش|طنشه|لا ترد|ما ابي ارد|مو الحين)$/;
const REJECT_WITH = /^(?:ارفض|ارفضها|ارفضه|سكر|سكر عليه|اقفل|كنسل|طنش)\s*(?:و|ثم)?\s*(?:قل|قول|ارسل|رسل|اكتب)\s*(?:له|لها|لهم)?\s*(.*)$/;
const MESSAGE_ONLY = /^(?:قل|قول|ارسل|رسل|اكتب)\s*(?:له|لها|لهم)\s+(.+)$/;
const DEFAULT_MESSAGE_REQUEST = /^(?:ارفض|ارفضها|سكر|اقفل)\s*(?:مع|ب)\s*(?:رساله|مسج)$|^(?:ارفض|سكر|اقفل)\s*(?:و|ثم)?\s*(?:ارسل|رسل)\s*(?:له|لها)?\s*(?:رساله|مسج)$/;

/**
 * What the driver said while the phone rings. Returns
 * { decision: 'answer' | 'reject' | 'reject_message', message? } or null (not a call command).
 */
export function parseCallCommand(transcript, { driving = false } = {}) {
  const text = normalizeArabic(String(transcript || '')).replace(/[.!؟?،,]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 200) return null;
  if (ANSWER.test(text)) return { decision: 'answer' };
  if (DEFAULT_MESSAGE_REQUEST.test(text)) return { decision: 'reject_message', message: driving ? DRIVING_CALL_MESSAGE : DEFAULT_CALL_MESSAGE };
  const withMessage = text.match(REJECT_WITH) || text.match(MESSAGE_ONLY);
  if (withMessage) {
    const said = cleanCallMessage(spokenMessage(transcript));
    return { decision: 'reject_message', message: said || (driving ? DRIVING_CALL_MESSAGE : DEFAULT_CALL_MESSAGE) };
  }
  if (REJECT.test(text)) return { decision: 'reject' };
  return null;
}

/** The words after «قل له / ارسل له», kept as the driver said them (not normalized). */
function spokenMessage(transcript) {
  const original = String(transcript || '').trim();
  const match = original.match(/(?:قل|قول|أرسل|ارسل|رسل|اكتب)\s*(?:له|لها|لهم)?\s*[:،,]?\s*(.+)$/);
  let message = match ? match[1].trim() : '';
  // «قل له إني أسوق» → «أنا أسوق»; «قل له اني مشغول» → «أنا مشغول»
  message = message.replace(/^(?:إني|اني|انني|إنني|بأني|باني)\s+/, 'أنا ');
  return message.replace(/[.،,]+$/, '');
}

// ---------------------------------------------------------------- numbers

const COUNTRY_CODES = { sa: '966', ae: '971', kw: '965', qa: '974', bh: '973', om: '968', eg: '20', jo: '962', iq: '964', ye: '967', lb: '961', sy: '963', sd: '249', ma: '212', dz: '213', tn: '216', ly: '218', us: '1', gb: '44', tr: '90', pk: '92', in: '91' };

/** Caller number as the phone shows it (local or international) → international digits, or null. */
export function internationalNumber(number, simCountryIso = 'sa') {
  let digits = String(number || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) {
    const code = COUNTRY_CODES[String(simCountryIso || 'sa').toLowerCase()] || COUNTRY_CODES.sa;
    digits = code + digits.slice(1);
  }
  digits = digits.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function whatsAppJidFor(number, simCountryIso) {
  const digits = internationalNumber(number, simCountryIso);
  return digits ? `${digits}@s.whatsapp.net` : null;
}
