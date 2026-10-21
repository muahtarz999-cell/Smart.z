import { normalizeArabic } from './arabic-normalize.js';

const DOCUMENT_NOUNS = new Set([
  'عقد', 'عقود', 'نص', 'نصوص', 'رد', 'جواب', 'مسوده', 'خطاب', 'اتفاقيه', 'كلام',
  'وثيقه', 'سيره', 'مذكره', 'اقرار', 'مستند', 'ملف', 'ملفات', 'مرفق', 'مرفقات',
]);
const DEMONSTRATIVES = new Set(['هذا', 'هاذا', 'هادا', 'هذه', 'هاذي', 'هذي', 'ذلك', 'ذا']);
const QUESTION_START = /^(كيف|كيفيه|ليش|لماذا|متى|وين|اين|وش|ايش)(\s|$)/;
const SAVE_VERB_STEM = /^[وفتنيا]{0,2}(نقل|حفظ|خزن|اضف|ضيف)/;
const SAVE_VERB_EXACT = /^[وف]?(ضع|حط)(ه|ها)?$/;
const DOWNLOAD_TERM = /(?:^|\s)[وفتنيا]?(?:حمل|نزل|صدر)(?:ه|ها)?(?:\s|$)|تحميل|تنزيل|تصدير/;
const PDF_TERM = /(?:^|\s)(?:pdf|بي دي اف|بيدياف)(?:\s|$)/;
const TITLE_REQUEST = /(?:باسم|بعنوان|اسمه|اسمها|سمه|سميه)\s+[«"“]?([^«»"“”\n]{2,80}?)[»"”]?\s*$/;

function stripArticle(token) {
  if (/^(وال|بال|كال|فال)/.test(token)) return token.slice(3);
  if (token.startsWith('لل') && token.length > 4) return token.slice(2);
  if (token.startsWith('ال') && token.length > 3) return token.slice(2);
  return token;
}

function hasDocumentNoun(tokens) { return tokens.some((token) => DOCUMENT_NOUNS.has(token) || DOCUMENT_NOUNS.has(stripArticle(token))); }
function hasDemonstrative(tokens) { return tokens.some((token) => DEMONSTRATIVES.has(token)); }
function hasSaveVerb(tokens) { return tokens.some((token) => SAVE_VERB_STEM.test(token) || SAVE_VERB_EXACT.test(token)); }
function hasPronounVerb(tokens, pattern) { return tokens.some((token) => pattern.test(token) && /(?:ه|ها)$/.test(token)); }

export function parseDocumentCommand(text) {
  const original = String(text || '').trim();
  if (!original || original.length > 200) return null;
  const normalized = normalizeArabic(original);
  if (!normalized || QUESTION_START.test(normalized)) return null;
  const tokens = normalized.split(' ');
  const mentionsDestination = /مستندات/.test(normalized);
  const pointsAtText = hasDocumentNoun(tokens) || hasDemonstrative(tokens);
  let action = null;
  if (mentionsDestination && hasSaveVerb(tokens) && (pointsAtText || hasPronounVerb(tokens, /^[وفتنيا]{0,2}(نقل|حفظ|خزن|اضف|ضيف|ضع|حط)/))) action = 'save';
  else if (DOWNLOAD_TERM.test(normalized) && (pointsAtText || hasPronounVerb(tokens, /^[وفتنيا]?(حمل|نزل|صدر)/))) action = 'download';
  if (!action) return null;
  const source = tokens.some((token) => ['ملف', 'مرفق', 'ملفات', 'مرفقات'].includes(stripArticle(token))) ? 'file' : 'reply';
  return { action, format: PDF_TERM.test(normalized) ? 'pdf' : 'docx', source, title: original.match(TITLE_REQUEST)?.[1]?.trim() || null };
}

export function pickDocumentReply(messages, { minCharacters = 120 } = {}) {
  const replies = (Array.isArray(messages) ? messages : []).filter((message) => message?.role === 'assistant' && typeof message.content === 'string')
    .map((message) => message.content.trim()).reverse().slice(0, 8);
  return replies.find((reply) => reply.length >= minCharacters) || null;
}

export function cleanReplyForDocument(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((line) => line.replace(/\s+$/, ''));
  const nonEmpty = () => lines.filter((line) => line.trim());
  const first = nonEmpty()[0];
  if (first && nonEmpty().length >= 4 && first.trim().length <= 100 && /[:：]\s*$/.test(first)
    && !/^(عقد|اتفاق|خطاب|سيره|اقرار|وثيقه)/.test(normalizeArabic(first))) lines.splice(lines.indexOf(first), 1);
  const remaining = nonEmpty();
  const last = remaining[remaining.length - 1];
  if (last && remaining.length >= 4 && last.trim().length <= 160 && /[؟?]\s*$/.test(last)) lines.splice(lines.lastIndexOf(last), 1);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function tidyTitle(value) { return String(value || '').replace(/^#+\s*/, '').replace(/[*_`«»"“”]/g, '').replace(/[\s:：،,.؛-]+$/g, '').trim().slice(0, 80); }
const DOCUMENT_TITLE_PHRASE = /(عقد|اتفاقي[ةه]|خطاب|إقرار|اقرار|مذكرة|وثيقة|سيرة ذاتية)(?:\s+[\u0600-\u06FF]+){1,2}/;
export function titleFromBody(body, fallback = 'مستند') {
  const lines = String(body || '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 10);
  const heading = lines.find((line) => /^#{1,3}\s+\S/.test(line));
  if (heading) return tidyTitle(heading) || fallback;
  const named = lines.find((line) => line.length <= 80 && /^(عقد|اتفاق|خطاب|سيره|اقرار|مذكره|وثيقه)/.test(normalizeArabic(line.replace(/[*#_`]/g, ''))));
  if (named) return tidyTitle(named) || fallback;
  for (const line of lines) { const phrase = line.match(DOCUMENT_TITLE_PHRASE); if (phrase) return tidyTitle(phrase[0]) || fallback; }
  return fallback;
}
