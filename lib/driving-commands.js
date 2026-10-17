/**
 * Driving mode phrases, shared by the app, the server and (ported) the
 * Android service. Matching is done on normalised Arabic, so "أنهِ"/"انهي"
 * and "القيادة"/"القياده" are the same.
 */
import { normalizeArabic } from './arabic-normalize.js';
import { resolveVoiceTrigger } from './voice-trigger.js';

const MODE = 'وضع القياده';
const STOP_VERBS = /((^| )انه( |$)|انتهي|انتها|انهي|انهاء|اوقف|ايقاف|وقف|اطفي|طفي|سكر|اغلق|قفل|الغي|الغاء|اخرج|خروج|خلص|خلاص|بس|stop)/;
// Words allowed around «وضع القيادة» in a start command; anything else makes it a question or a message.
const START_WORDS = new Set(['شغل', 'تشغيل', 'فعل', 'تفعيل', 'ابدا', 'افتح', 'ادخل', 'ابي', 'ابغي', 'حط', 'خلي', 'يا', 'سمارت', 'لو', 'سمحت', 'من', 'فضلك', 'الحين', 'الان', 'على', 'علي']);
// Whisper spells the spoken verbs many ways: «فاعل»، «فعّلي»، «شغلي»، «شاغل»، «تفعل»…
const START_VERB = /^(و)?(ت)?(فاعل|فعل|شاغل|شغل|شغال|شغلي|فعلي|فعللي|شغللي)(ي|لي|ه|ها)?$/;
const START_EXTRA = new Set(['لي', 'ابغي', 'ابغا', 'ابي', 'بغيت', 'ودي', 'ممكن', 'رجاء', 'الله', 'يخليك', 'اوكي', 'طيب', 'هلا', 'زين', 'نشغل', 'نفعل']);
function isStartWord(word) {
  return START_WORDS.has(word) || START_EXTRA.has(word) || START_VERB.test(word);
}
const QUESTION_WORDS = /^(كيف|ما|ماذا|وش|ايش|اشرح|شرح|هل|متي|ليش|لماذا)( |$)/;
const ARRIVED = /^(وصلت|وصلنا)( الحمد لله| الحمدلله| خلاص| يا سمارت)?$/;

// Groq Whisper invents these from silence or road noise; they are never real commands.
const HALLUCINATIONS = [
  'اشتركوا في القناه', 'اشترك في القناه', 'الاشتراك في القناه', 'لا تنسوا الاشتراك', 'لا تنسي الاشتراك',
  'شكرا للمشاهده', 'شكرا علي المشاهده', 'نانسي قنقر', 'ترجمه نانسي', 'سبتايتل', 'subtitles by',
  'مرحبا بكم في قناتي', 'تابعونا', 'المترجم للقناه', 'thanks for watching',
];
const NOISE_ONLY = new Set(['موسيقي', 'music', 'ضحك', 'تصفيق', 'صمت', 'اه', 'امم', 'ام', 'هم']);

const words = (text) => (text ? text.split(' ').length : 0);

/** "وضع القيادة انتهى", "أنهِ وضع القيادة", "وصلت" … */
export function isDrivingStopCommand(text) {
  const t = normalizeArabic(text);
  if (!t) return false;
  if (ARRIVED.test(t)) return true;
  return t.includes(MODE) && STOP_VERBS.test(t.replace(MODE, ' ')) && words(t) <= 7;
}

/** "وضع القيادة", "شغّل وضع القيادة" — but not "اشرح لي وضع القيادة". */
export function isDrivingStartCommand(text) {
  const t = normalizeArabic(text);
  if (!t.includes(MODE) || isDrivingStopCommand(text) || QUESTION_WORDS.test(t)) return false;
  const rest = t.replace(MODE, ' ').replace(/\s+/g, ' ').trim();
  return !rest || (words(rest) <= 4 && rest.split(' ').every(isStartWord));
}

/** Same phrases as the send undo window ("تراجع", "لا ترسل" …). */
export const CANCEL_PATTERN = /^\s*(تراجع|تراجعي|الغ|ألغ|الغي|ألغي|إلغاء|الغاء|لا ترسل|لا تبعث|وقف|كنسل|cancel|stop)/i;

export function isCancelCommand(text) {
  return CANCEL_PATTERN.test(String(text || ''));
}

/** True for empty transcripts, noise words and Whisper's well-known silence hallucinations. */
export function isLikelyHallucination(text) {
  const t = normalizeArabic(text);
  if (t.replace(/\s/g, '').length < 2) return true;
  if (NOISE_ONLY.has(t)) return true;
  return HALLUCINATIONS.some((phrase) => t.includes(normalizeArabic(phrase)));
}

export const DRIVING_MESSAGES = Object.freeze({
  started: 'وضع القيادة يعمل. تكلّم متى شئت، وقل «وضع القيادة انتهى» للإيقاف.',
  startedByName: 'وضع القيادة يعمل. نادِني «سمارت» قبل سؤالك، وقل «وضع القيادة انتهى» للإيقاف.',
  called: 'نعم، تفضّل.',
  stopped: 'أنهيت وضع القيادة. قُد بأمان.',
  idle: 'لم أسمع شيئاً منذ مدة، فأوقفت وضع القيادة.',
  disabled: 'وضع القيادة غير مفعّل. فعّله من الإعدادات أولاً.',
  heldForConfirmation: 'حفظت الرسالة، وتحتاج تأكيدك على الشاشة حين تتوقف.',
  bulkHeld: 'هذا إرسال لأكثر من خمسة أشخاص، حفظته لك وتؤكده على الشاشة حين تتوقف.',
  documentHeld: 'سأجهّز المستند وأرسله حين تفتح التطبيق.',
  cancelled: 'ألغيت الإرسال.',
});

/** The name the driver says before a question when "call by name" is on. */
export const CALL_NAME = 'سمارت';

/**
 * After the assistant answers, the driver may reply without the name for this
 * long ("لمن أرسلها؟" → "لأحمد"). Measured from the end of the reply.
 */
export const FOLLOW_UP_MS = 12_000;

/**
 * "Call by name": in a car with passengers, only sentences addressed to the
 * assistant are answered. Returns
 *   { accept: false }                         — not addressed to the assistant: ignore silently
 *   { accept: true, text, onlyName: true }    — just the name: answer "نعم، تفضّل."
 *   { accept: true, text }                    — the request, with the name removed
 * Stop and cancel commands are checked by the caller before this, so they
 * always work without the name.
 */
export function resolveCallByName(transcript, { required = false, followUp = false } = {}) {
  const original = String(transcript || '').trim();
  const trigger = resolveVoiceTrigger(original);
  if (trigger.triggered) return { accept: true, text: trigger.text, onlyName: !trigger.text };
  if (!required || followUp) return { accept: true, text: original };
  return { accept: false, text: original };
}
