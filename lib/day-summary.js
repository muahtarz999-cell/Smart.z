/**
 * «لخّص يومي» (owner request 2026-10-22): on the user's request only, one summary
 * of the day's WhatsApp messages, SMS, phone calls and the calls the AI
 * receptionist answered. Pure helpers shared by the app and the server.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LINES_PER_SOURCE = 80;
const MAX_LINE = 400;
export const MAX_SUMMARY_CHARACTERS = 14_000;

function normalize(text) {
  return String(text || '')
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[؟?!.،,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// «لخص يومي»، «ملخص اليوم»، «وش فاتني»، «وش صار اليوم»، «لخص لي كل شي اليوم»، «ملخص امس»
const SUMMARY_WORD = /(^|\s)(لخص|لخصلي|ملخص|خلاصه|تلخيص)(\s|$)/;
const DAY_WORD = /(يومي|اليوم|امس|البارحه|نهاري|كل شي|كل شيء|الي فاتني|اللي فاتني)/;
const MISSED = /(^|\s)(وش|ايش|شو|ماذا|هل)( اللي| الي)? (فاتني|فات علي|صار اليوم|صار علي|حصل اليوم|جاني اليوم)/;

export function isDaySummaryRequest(text) {
  const value = normalize(text);
  if (!value || value.length > 120) return false;
  return (SUMMARY_WORD.test(value) && DAY_WORD.test(value)) || MISSED.test(value);
}

/** 'yesterday' for «أمس / البارحة», else 'today'. */
export function summaryPeriod(text) {
  return /(امس|البارحه)/.test(normalize(text)) ? 'yesterday' : 'today';
}

/** [from, to) in ms for the period, midnight to midnight in the user's zone (offset in minutes, like getTimezoneOffset). */
export function periodRange(period, now = Date.now(), offsetMinutes = -180) {
  const local = now - offsetMinutes * 60_000;
  const startOfToday = Math.floor(local / DAY_MS) * DAY_MS + offsetMinutes * 60_000;
  return period === 'yesterday' ? { from: startOfToday - DAY_MS, to: startOfToday } : { from: startOfToday, to: now + 1 };
}

// Verification codes and passwords never reach the model, even from the user's own SMS.
const SECRET_CUE = /(رمز|كود|كلمه المرور|كلمة المرور|otp|code|password|pin|تحقق|التحقق|verification)/i;
export function redactSecrets(text) {
  const value = String(text || '');
  return SECRET_CUE.test(value) ? value.replace(/\d[\d\s-]{3,10}\d/g, '••••') : value;
}

const clip = (value, max = MAX_LINE) => String(value || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** SMS from the phone → lines (newest last), with codes hidden. */
export function smsLines(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item.body === 'string' && item.body.trim())
    .sort((a, b) => Number(a.date) - Number(b.date))
    .slice(-MAX_LINES_PER_SOURCE)
    .map((item) => `${clip(item.name || item.address || 'مرسل', 60)}: ${clip(redactSecrets(item.body))}`);
}

const CALL_TYPES = { missed: 'فائتة', incoming: 'واردة', outgoing: 'صادرة', rejected: 'مرفوضة' };

/** Phone call log → lines. */
export function callLines(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && CALL_TYPES[item.type])
    .sort((a, b) => Number(a.date) - Number(b.date))
    .slice(-MAX_LINES_PER_SOURCE)
    .map((item) => {
      const minutes = Math.round(Number(item.duration || 0) / 60);
      return `مكالمة ${CALL_TYPES[item.type]}: ${clip(item.name || item.number || 'رقم مخفي', 60)}${minutes ? ` (${minutes} د)` : ''}`;
    });
}

/** Calls the AI receptionist answered (from /api/receptionist/calls) → lines. */
export function receptionistLines(calls = [], range = null) {
  return (Array.isArray(calls) ? calls : [])
    .filter((call) => {
      if (!range) return true;
      const at = Date.parse(call.started_at || call.created_at || '');
      return Number.isFinite(at) && at >= range.from && at < range.to;
    })
    .slice(0, MAX_LINES_PER_SOURCE)
    .map((call) => `رد عليه موظف الاستقبال${call.urgent ? ' (عاجل)' : ''}: ${clip(call.caller_name || call.caller_number || 'متصل', 60)} — ${clip(call.summary || call.message || '')}`);
}

/** Everything the app gathered, cleaned again on the server and capped. */
export function sanitizeSummaryContext(value) {
  const list = (lines) => (Array.isArray(lines) ? lines : [])
    .filter((line) => typeof line === 'string' && line.trim())
    .slice(-MAX_LINES_PER_SOURCE * 2)
    .map((line) => clip(line, MAX_LINE + 80));
  return {
    period: value?.period === 'yesterday' ? 'yesterday' : 'today',
    whatsapp: list(value?.whatsapp),
    sms: list(value?.sms),
    calls: list(value?.calls),
    receptionist: list(value?.receptionist),
    commitments: list(value?.commitments).slice(0, 20),
    unavailable: list(value?.unavailable).slice(0, 5),
  };
}

/** The prompt section for the summary, within a size budget (newest kept). */
export function summaryContextToPrompt(context) {
  const clean = sanitizeSummaryContext(context);
  let budget = MAX_SUMMARY_CHARACTERS;
  const section = (title, lines) => {
    if (!lines.length) return `${title}: لا شيء.`;
    const kept = [];
    for (const line of [...lines].reverse()) {
      if (budget - line.length < 0) break;
      budget -= line.length;
      kept.unshift(line);
    }
    return `${title} (${lines.length}):\n${kept.join('\n')}`;
  };
  return [
    `طلب المستخدم ملخص ${clean.period === 'yesterday' ? 'أمس' : 'يومه'}. هذه بياناته من هاتفه:`,
    section('رسائل واتساب', clean.whatsapp),
    section('رسائل SMS', clean.sms),
    section('سجل المكالمات', clean.calls),
    section('مكالمات رد عليها موظف الاستقبال', clean.receptionist),
    clean.commitments.length ? section('أشياء مستحقة اليوم استنتجها التطبيق من محادثاته', clean.commitments) : '',
    clean.unavailable.length ? `لم يمكن الوصول إلى: ${clean.unavailable.join('، ')}. اذكر ذلك بجملة قصيرة.` : '',
    'اكتب ملخصًا مرتبًا بالأهمية: ما يحتاج ردًا أو اتصالًا أولًا، ثم المهم، ثم الباقي باختصار شديد. اجمع رسائل الشخص الواحد معًا، وتجاهل الرسائل الإعلانية وأرقام التحقق. لا تخترع شيئًا غير موجود، ولا تقرأ الأرقام كاملة.',
  ].filter(Boolean).join('\n\n');
}
