import { searchChunks } from './local-search.js';

export const OFFICIAL_SOURCE = 'laws.boe.gov.sa';
export const SUGGESTED_LAWS = Object.freeze(['نظام العمل', 'نظام المعاملات المدنية', 'نظام التنفيذ', 'نظام الإثبات', 'نظام المرافعات الشرعية', 'نظام الأحوال الشخصية']);
// Official Bureau of Experts pages. They always expose the current text and its
// original attachment, so the user can download the authoritative version.
export const OFFICIAL_LAW_LINKS = Object.freeze({
  'نظام العمل': 'https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1',
  'نظام المعاملات المدنية': 'https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/655fdb42-8c96-422b-b8c4-b04f0095c94c/1',
  'نظام التنفيذ': 'https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/c81ba2f1-1bf1-443b-9b1c-a9a700f27110/1',
  'نظام الإثبات': 'https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/2716057c-c097-4bad-8e1e-ae1400c678d5/1',
  'نظام المرافعات الشرعية': 'https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/f0eaae46-9f84-40ee-815e-a9a700f268b3/1',
  'نظام الأحوال الشخصية': 'https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/4d72d829-947b-45d5-b9b5-ae5800d6bac2/1',
});
const MAX_ARTICLE_CHARACTERS = 3000;
const MAX_CONTEXT_CHARACTERS = 12000;
const fold = (text) => String(text || '').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
const UNITS = { اول: 1, اولي: 1, حادي: 1, حاديه: 1, ثاني: 2, ثانيه: 2, ثالث: 3, ثالثه: 3, رابع: 4, رابعه: 4, خامس: 5, خامسه: 5, سادس: 6, سادسه: 6, سابع: 7, سابعه: 7, ثامن: 8, ثامنه: 8, تاسع: 9, تاسعه: 9, عاشر: 10, عاشره: 10 };
const TENS = { عشرون: 20, عشرين: 20, ثلاثون: 30, ثلاثين: 30, اربعون: 40, اربعين: 40, خمسون: 50, خمسين: 50, ستون: 60, ستين: 60, سبعون: 70, سبعين: 70, ثمانون: 80, ثمانين: 80, تسعون: 90, تسعين: 90 };
const HUNDREDS = { مايه: 100, مائه: 100, ماءه: 100, مايتين: 200, مائتين: 200, ماءتين: 200, مايتان: 200, مائتان: 200 };
const toLatinDigits = (text) => String(text).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
function parseOrdinalWords(words) {
  let total = 0; let lastUnit = false; let any = false;
  for (let word of words) {
    if (word.startsWith('و') && word.length > 2) word = word.slice(1);
    if (word.startsWith('ال')) word = word.slice(2);
    if (word in UNITS) { total += UNITS[word]; lastUnit = true; any = true; continue; }
    if ((word === 'عشر' || word === 'عشره') && lastUnit) { total += 10; lastUnit = false; any = true; continue; }
    if (word in TENS) { total += TENS[word]; lastUnit = false; any = true; continue; }
    if (word in HUNDREDS) { total += HUNDREDS[word]; lastUnit = false; any = true; continue; }
    return null;
  }
  return any ? total : null;
}
export function parseArticleNumber(label) {
  const text = toLatinDigits(String(label || '')).replace(/["“”()\u061B:：]/g, ' ').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const words = fold(text).split(/\s+/).filter(Boolean);
  const after = words.indexOf('بعد');
  if (after > 0) { const head = parseOrdinalWords(words.slice(0, after)); const hundreds = parseOrdinalWords(words.slice(after + 1)); return head && hundreds >= 100 ? head + hundreds : null; }
  return words.length && words.length <= 6 ? parseOrdinalWords(words) : null;
}
const HEADING = /(?:^|[\s\n])(المادة\s*((?:\(\s*[\d٠-٩]+\s*\)|[\d٠-٩]+|[\u0621-\u064A\u064B-\u065F\s]{2,45}?))(?:\s*["“(]\s*[\d٠-٩]+\s*["”)])?\s*[:：])/g;
export function parseLawArticles(rawText) {
  const text = String(rawText || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ');
  const headings = [];
  for (const match of text.matchAll(HEADING)) {
    const number = parseArticleNumber(match[2]);
    if (number === null) continue;
    const start = match.index + match[0].indexOf(match[1]);
    headings.push({ number, label: `المادة ${match[2].trim()}`, start, end: start + match[1].length });
  }
  return headings.map((heading, index) => ({ number: heading.number, label: heading.label, text: text.slice(heading.end, headings[index + 1]?.start ?? text.length).replace(/\s*\n\s*/g, '\n').trim() })).filter((article) => article.text);
}
export function missingArticleNumbers(articles) { const have = new Set((articles || []).map((a) => a.number)); const max = Math.max(0, ...have); return Array.from({ length: max }, (_, i) => i + 1).filter((n) => !have.has(n)); }
export function searchLegal(laws, query, { limit = 6, lawNames } = {}) {
  const wanted = (lawNames || []).map(fold); const selected = wanted.length ? laws.filter((law) => wanted.some((name) => fold(law.name).includes(name))) : laws; const pool = selected.length ? selected : laws;
  const chunks = pool.flatMap((law) => (law.articles || []).map((article) => ({ id: `${law.id}:${article.number}`, lawId: law.id, lawName: law.name, number: article.number, label: article.label, text: article.text })));
  const directMatch = toLatinDigits(String(query || '')).match(/المادة\s*\(?\s*(\d{1,3})\s*\)?/); const direct = directMatch ? chunks.filter((c) => c.number === Number(directMatch[1])).map((c) => ({ ...c, score: 100 })) : [];
  const ranked = searchChunks(chunks, query, { limit }).filter((hit) => !direct.some((item) => item.id === hit.id));
  return [...direct, ...ranked].slice(0, limit);
}
export function sanitizeLegalArticles(input) { if (!Array.isArray(input)) return []; const clean = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u001F]/g, ' ').trim().slice(0, n) : ''; return input.slice(0, 12).map((item) => ({ law: clean(item?.law, 120), label: clean(item?.label, 60), text: clean(item?.text, MAX_ARTICLE_CHARACTERS), importedAt: clean(item?.importedAt, 20) })).filter((item) => item.law && item.label && item.text); }
export function legalContextToPrompt(articles) { const items = sanitizeLegalArticles(articles); if (!items.length) return ''; let total = 0; const lines = []; for (const item of items) { if (total + item.text.length > MAX_CONTEXT_CHARACTERS) break; total += item.text.length; lines.push(`[${item.law} — ${item.label}${item.importedAt ? ` — استُورد ${item.importedAt}` : ''}] ${item.text}`); } return ['مواد من المكتبة القانونية على جهاز المستخدم:', ...lines, 'استند إلى هذه المواد وحدها، واذكر اسم النظام ورقم المادة. إن لم تكفِ فقل إن المكتبة لا تحتوي نصًا كافيًا، ولا تذكر أحكامًا من ذاكرتك.', 'المرجع النهائي هو المصدر الرسمي وقد يكون النظام عُدّل بعد تاريخ الاستيراد.'].join('\n'); }
export function hitsToLegalContext(hits, dates = {}) { return (hits || []).map((hit) => ({ law: hit.lawName, label: hit.label, text: hit.text, importedAt: dates[hit.lawId] || '' })); }
