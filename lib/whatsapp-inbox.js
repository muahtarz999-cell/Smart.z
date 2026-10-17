/**
 * WhatsApp messages kept on the customer's phone (pure helpers, shared by
 * the app and the server). The phone stores them in IndexedDB (see
 * whatsapp-inbox-store.js) and deletes them after the retention period;
 * the server only passes them through and never keeps a copy.
 */

export const INBOX_RETENTION_OPTIONS = [1, 3, 7, 14, 30];
export const DEFAULT_INBOX_RETENTION_DAYS = 7;
const MAX_ITEM_TEXT = 2000;
const MAX_CONTEXT_CHARACTERS = 9000;
const MAX_CONTEXT_MESSAGES = 120;

function clean(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, max) : '';
}

/** Keeps only well-formed items from a node; anything else is dropped. */
export function sanitizeInboxItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item.id === 'string' && item.id && typeof item.text === 'string' && item.text.trim())
    .slice(0, 500)
    .map((item) => ({
      id: item.id.slice(0, 128),
      chatJid: clean(item.chatJid, 80),
      chatName: clean(item.chatName, 120),
      senderName: clean(item.senderName, 120),
      senderNumber: clean(item.senderNumber, 20).replace(/\D/g, ''),
      isGroup: Boolean(item.isGroup),
      text: clean(item.text, MAX_ITEM_TEXT),
      sentAt: Number.isFinite(Number(item.sentAt)) ? Number(item.sentAt) : Date.now(),
    }));
}

export function normalizeRetentionDays(value) {
  const days = Number(value);
  return INBOX_RETENTION_OPTIONS.includes(days) ? days : DEFAULT_INBOX_RETENTION_DAYS;
}

/**
 * Does the user ask about their WhatsApp messages? ("لخص رسائلي",
 * "مين كلمني اليوم", "وش وصلني في الواتس"). Sending requests are excluded:
 * the send tool handles those.
 */
// Spoken Arabic reaches us in many spellings (Whisper writes "الغير مقروءة",
// "رسايل", "الواتساب"…), so matching works on a normalised form: no
// diacritics or tatweel, one alef, ه for ة, ي for ى.
function normalizeForIntent(text) {
  return String(text || '')
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Asking about received messages, even without the word "message".
const RECEIVED = /(رسائلي|رسايلي|مسجاتي|وصلني|وصلتني|وصلني شي|جاني|جتني|مين (كلمني|راسلني|ارسل لي|ارسلي|دق علي)|من (كلمني|راسلني|ارسل لي)|احد (كلمني|راسلني|ارسل)|غير مقروء|الغير مقروء|مو مقروء|ما قريت|ماقريت|ما قرات|ما شفت|ماشفت|whatsapp messages|my messages|unread)/;
// A message noun, then a cue that the user wants to look at them.
const MESSAGE_NOUN = /(رسائل|رسايل|رساله|الرساله|مسج|مسجات|محادث|واتس|وتس|whatsapp)/;
// Verbs and words safe to match inside longer words, plus short words matched
// only as whole words ("فيه" must not match "فيها", "كم" not "حكم").
const LOOK_CUE = /(اطلع|طالع|شوف|اقرا|اقري|افتح|راجع|افحص|تفقد|تحقق|جديد|وارد|لخص|ملخص|تقرير|اعرض|ورني|وريني|اليوم|امس|الاسبوع|(^|\s)(شف|عندي|عندك|فيه|في احد|هل|وش|ايش|اش|شو|مين|كم|اخر)(\s|$|\?|؟))/;
// Sending or replying: the send tool handles those.
const SEND = /(^|\s)(ارسل|ابعث|راسل|رد علي|رد على|ردي علي|جاوب|قول ل|قل ل|قولي ل|بلغ)(\s|ل|$)/;

/**
 * Does the user ask about their WhatsApp messages? ("لخص رسائلي",
 * "اطلع على الرسائل الغير مقروءة", "شوف الواتس"). Sending requests are
 * excluded: the send tool handles those.
 */
export function isInboxQuestion(text) {
  const value = normalizeForIntent(text);
  if (!value) return false;
  if (SEND.test(value) && !RECEIVED.test(value)) return false;
  return RECEIVED.test(value) || (MESSAGE_NOUN.test(value) && LOOK_CUE.test(value));
}

function formatTime(ms) {
  try {
    return new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Riyadh',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * Compact transcript of stored messages for the assistant, newest last,
 * within a size budget. items: sanitised inbox items.
 */
export function buildInboxContext(items, { now = Date.now() } = {}) {
  const sorted = [...(Array.isArray(items) ? items : [])].sort((a, b) => a.sentAt - b.sentAt);
  const lines = [];
  let total = 0;
  for (const item of sorted.slice(-MAX_CONTEXT_MESSAGES).reverse()) {
    const who = item.senderName || (item.senderNumber ? `+${item.senderNumber}` : 'مجهول');
    const where = item.isGroup ? ` في مجموعة «${item.chatName || 'مجموعة'}»` : '';
    const line = `[${formatTime(item.sentAt)}] ${who}${where}: ${item.text.replace(/\s+/g, ' ')}`;
    if (total + line.length > MAX_CONTEXT_CHARACTERS) break;
    total += line.length;
    lines.unshift(line);
  }
  return { count: sorted.length, shown: lines.length, oldest: sorted[0]?.sentAt || null, generatedAt: now, lines };
}

/**
 * The WhatsApp server could not be asked just now (a sleeping node takes up to
 * a minute to wake), so newer messages may still be waiting there. Without
 * this the assistant said "no messages" while messages were on their way.
 */
function inboxLinkNote(context) {
  if (context?.waking !== true) return '';
  return 'تنبيه: خادم واتساب كان يستيقظ ولم يرسل أحدث الرسائل بعد، فقد توجد رسائل جديدة لم تصل. قل ذلك للمستخدم بجملة واحدة واطلب منه أن يسأل مجددًا بعد دقيقة، ولا تقل إنه لا توجد رسائل.';
}

/** Server side: the context the app attached, re-validated and turned into prompt text. */
export function inboxContextToPrompt(context) {
  if (!context || !Array.isArray(context.lines)) return '';
  const lines = context.lines.filter((line) => typeof line === 'string' && line.trim())
    .slice(-MAX_CONTEXT_MESSAGES).map((line) => line.slice(0, MAX_ITEM_TEXT + 200));
  let total = 0;
  const kept = [];
  for (const line of [...lines].reverse()) {
    if (total + line.length > MAX_CONTEXT_CHARACTERS) break;
    total += line.length;
    kept.unshift(line);
  }
  const state = inboxLinkNote(context);
  if (context.linked === false) {
    return 'المستخدم يسأل عن رسائل WhatsApp، لكن رقمه غير مربوط بالتطبيق الآن. أخبره بإيجاز أن يربط واتساب من الإعدادات ليقرأ المساعد رسائله، ولا تقل إنه لا توجد رسائل.';
  }
  if (!kept.length) {
    if (state) return `المستخدم يسأل عن رسائل WhatsApp الواردة، ولا توجد رسائل محفوظة على جهازه حتى الآن. ${state}`;
    return 'المستخدم يسأل عن رسائل WhatsApp الواردة، ولا توجد رسائل محفوظة على جهازه بعد. أخبره بذلك بإيجاز، وأن الرسائل تُجمع من وقت ربط رقمه وتبقى على هاتفه فقط.';
  }
  const count = Number.isInteger(context.count) ? context.count : kept.length;
  return [
    `رسائل WhatsApp الواردة إلى المستخدم، محفوظة على هاتفه (${count} رسالة، المعروض ${kept.length}، الأحدث في الأسفل):`,
    ...kept,
    ...(state ? [state] : []),
    'استخدمها للإجابة عن سؤاله: لخّص حسب المرسل، وقدّم ما يبدو مهمًا أو يحتاج ردًا، واذكر الأوقات عند الحاجة. لا تخترع رسائل غير موجودة، ولا تعرض الأرقام كاملة إلا إذا طلبها.',
    'التطبيق لا يعرف أي الرسائل قرأها المستخدم في واتساب. إذا سأل عن غير المقروءة فاعرض الأحدث منها ووضّح ذلك في جملة، ولا تقل إنه لا توجد رسائل غير مقروءة.',
  ].join('\n');
}
