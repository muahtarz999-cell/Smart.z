/**
 * Hidden promises memory (owner request 2026-10-22). Not shown anywhere in the
 * app: from the user's WhatsApp chats (what they promised, and what others
 * promised them), the app keeps short notes on the phone that expire on their
 * own, and the assistant uses them only when the user asks («وش وعدت؟»،
 * «وش علي اليوم؟») or asks for the day summary. Pure helpers.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const COMMITMENT_TTL_AFTER_DUE_MS = 3 * DAY_MS;
export const COMMITMENT_TTL_WITHOUT_DUE_MS = 10 * DAY_MS;
export const MAX_COMMITMENTS = 60;
export const MAX_EXTRACTION_LINES = 60;

function normalize(text) {
  return String(text || '')
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Cheap filter on the phone: only lines that sound like a promise or a plan go to the model.
const CUE = /(بكره|بكرا|باكر|بعد بكره|اليوم|الليله|العصر|المغرب|العشاء|الظهر|الصبح|بعدين|الحين|بعد شوي|الاسبوع|الشهر|الخميس|الجمعه|السبت|الاحد|الاثنين|الثلاثاء|الاربعاء|الساعه|موعد|اوعدك|وعد|ان شاء الله|انشالله|ابشر|تم|راح|بـ?ارسل|ارسل لك|احول|بحول|اكلمك|بكلمك|اتصل عليك|بتصل|امر عليك|بمر|اجيب|بجيب|اسدد|بسدد|ادفع|بدفع|اسلمك|بسلم|اخلص|بخلص|ارجع لك|برجع لك|send|tomorrow|tonight|will|promise)/;

export function looksLikeCommitment(text) {
  const value = normalize(text);
  return value.length >= 6 && value.length <= 600 && CUE.test(value);
}

/** Message items → lines for extraction ("أنا ← أحمد: …" for the user's own messages). */
export function extractionLines(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && !item.isGroup && typeof item.text === 'string' && looksLikeCommitment(item.text))
    .sort((a, b) => Number(a.sentAt) - Number(b.sentAt))
    .slice(-MAX_EXTRACTION_LINES)
    .map((item) => {
      const person = String(item.senderName || item.chatName || (item.senderNumber ? `+${item.senderNumber}` : 'شخص')).slice(0, 60);
      const when = new Date(Number(item.sentAt) || Date.now()).toISOString();
      const text = String(item.text).replace(/\s+/g, ' ').slice(0, 300);
      return item.outgoing ? `[${when}] أنا ← ${person}: ${text}` : `[${when}] ${person} ← لي: ${text}`;
    });
}

export const EXTRACTION_SYSTEM = `من محادثات واتساب لمستخدم، استخرج الالتزامات الواضحة فقط: ما وعد به هو غيره (mine)، وما وعده به غيره (theirs)، مع موعدها إن ذُكر.
أعد JSON فقط: {"items":[{"person":"","what":"","direction":"mine","due":""}]}
- what: جملة قصيرة بصيغة فعل، مثل «يرسل عقد الإيجار» أو «يحوّل المبلغ».
- due: تاريخ ووقت ISO 8601 بتوقيت السعودية (+03:00) محسوبًا من وقت الرسالة إن ذُكر موعد («بكرة العصر»، «الخميس»)، وإلا فارغ.
- تجاهل المجاملات والأسئلة والخطط الغامضة وما نُفّذ في نفس المحادثة. لا تخترع. إن لم يوجد شيء فأعد {"items":[]}.`;

const clip = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

function hashText(text) {
  let hash = 0;
  for (const char of text) hash = (Math.imul(31, hash) + char.codePointAt(0)) | 0;
  return (hash >>> 0).toString(36);
}

/** The model's items → stored records { id, person, what, direction, due, createdAt, expiresAt }. */
export function commitmentsFromModel(parsed, now = Date.now()) {
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  return items.slice(0, 20).map((item) => {
    const person = clip(item?.person, 60);
    const what = clip(item?.what, 200);
    if (!what) return null;
    const dueAt = Date.parse(item?.due || '');
    const due = Number.isFinite(dueAt) ? dueAt : null;
    return {
      id: `c-${hashText(`${normalize(person)}|${normalize(what)}`)}`,
      person,
      what,
      direction: item?.direction === 'theirs' ? 'theirs' : 'mine',
      due,
      createdAt: now,
      expiresAt: due ? due + COMMITMENT_TTL_AFTER_DUE_MS : now + COMMITMENT_TTL_WITHOUT_DUE_MS,
    };
  }).filter(Boolean);
}

export function isExpired(record, now = Date.now()) {
  return !record || !Number.isFinite(record.expiresAt) || record.expiresAt <= now;
}

// «وش وعدت»، «هل وعدني أحد»، «وش علي اليوم»، «التزاماتي»، «نسيت شي؟»
const QUESTION = /(وعدت|وعدني|وعدته|وعدتها|وعودي|التزاماتي|التزام|وش علي|ايش علي|شو علي|علي شي|نسيت شي|نسيت احد|مين ينتظر|مين ينتظرني|احد ينتظر|وش المطلوب مني|المستحق)/;

export function isCommitmentQuestion(text) {
  const value = normalize(text);
  return Boolean(value) && value.length <= 200 && QUESTION.test(value);
}

function formatDue(ms) {
  try {
    return new Intl.DateTimeFormat('ar-SA-u-nu-latn', { weekday: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Riyadh' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Live records → lines; `dueBy` keeps only those due by then (the day summary). */
export function commitmentLines(records = [], { now = Date.now(), dueBy = null } = {}) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => !isExpired(record, now))
    .filter((record) => (dueBy === null ? true : record.due !== null && record.due <= dueBy))
    .sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity))
    .slice(0, MAX_COMMITMENTS)
    .map((record) => `${record.direction === 'mine' ? `وعدتَ ${record.person || 'شخصًا'} أن` : `${record.person || 'شخص'} وعدك أن`} ${record.what}${record.due ? ` — ${formatDue(record.due)}${record.due < now ? ' (فات موعده)' : ''}` : ''}`);
}

/** Server side: the prompt text, only because the user asked. */
export function commitmentsContextToPrompt(lines) {
  const clean = (Array.isArray(lines) ? lines : []).filter((line) => typeof line === 'string' && line.trim())
    .slice(0, MAX_COMMITMENTS).map((line) => clip(line, 320));
  if (!clean.length) {
    return 'سأل المستخدم عن التزاماته أو وعوده، ولا توجد ملاحظات حديثة عنها. قل ذلك بإيجاز، واقترح أن يخبرك بما يريد تذكّره.';
  }
  return [
    'سأل المستخدم عن التزاماته أو وعوده. هذه ملاحظات استنتجها التطبيق على هاتفه من محادثاته الأخيرة في واتساب (قد تكون غير دقيقة):',
    ...clean,
    'أجب منها بلطف وبإيجاز، وقدّم ما فات موعده أو اقترب. قلها كتذكير لا كمراقبة، وإن سألك من أين عرفتها فقل بصدق إنها من رسائل واتساب المحفوظة على هاتفه، وتُمسح تلقائيًا خلال أيام.',
  ].join('\n');
}
