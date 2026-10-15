import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createZip, crc32, readZip } from '../lib/zip.js';
import { buildDocx } from '../lib/docx-export.js';
import { chunkPages, searchChunks } from '../lib/local-search.js';
import { normalizeArabic } from '../lib/arabic-normalize.js';
import { normalizeStudyResult } from '../lib/study-schema.js';
import { newReview, reviewCard } from '../lib/spaced-repetition.js';
import { answerVoiceQuiz, gradeAnswer, startVoiceQuiz } from '../lib/voice-quiz.js';
import { templateFromRequest, DOCUMENT_TEMPLATES } from '../lib/document-templates.js';
import { documentContextToPrompt } from '../lib/assistant-response.js';
import { analyzeImages } from '../lib/vision.js';

// Browser-only modules loaded with their relative imports stubbed.
async function loadWithStubs(path, replacements) {
  let source = await readFile(new URL(path, import.meta.url), 'utf8');
  for (const [from, to] of replacements) source = source.replace(from, to);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const zipUrl = new URL('../lib/zip.js', import.meta.url).href;
const processing = await loadWithStubs('../lib/file-processing.js', [
  ["import { readZip } from './zip';", `import { readZip } from '${zipUrl}';`],
  ["import { chunkPages } from './local-search';", `import { chunkPages } from '${new URL('../lib/local-search.js', import.meta.url).href}';`],
  ["import { newId } from './idb';", 'const newId = () => "x";'],
]);
const attachments = await loadWithStubs('../lib/attachments.js', [
  ["import { blobToBase64, renderPdfPage } from './file-processing';", 'const blobToBase64 = null; const renderPdfPage = null;'],
  ["import { findRelevantPassages, getFile } from './file-store';", 'const findRelevantPassages = null; const getFile = null;'],
]);
const study = await loadWithStubs('../lib/study.js', [
  [/import \{[^}]+\} from '\.\/idb';/, 'const getAllByIndex = null, newId = null, putRecord = null, getRecord = null, deleteRecord = null;'],
  ["import { getChunksInRange } from './file-store';", 'const getChunksInRange = null;'],
  ["import { newReview, reviewCard, isDue } from './spaced-repetition';", 'const newReview = null, reviewCard = null, isDue = null;'],
  ["import { saveLocalRecord, listLocalRecords } from './local-data';", 'const saveLocalRecord = null, listLocalRecords = null;'],
  ["import { synchronizeTaskReminders } from './task-notifications';", 'const synchronizeTaskReminders = null;'],
]);

// ---------------------------------------------------------------- zip and Word
test('zip: CRC-32 is standard and stored archives round-trip', async () => {
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
  const zip = readZip(createZip([{ name: 'a.txt', data: 'مرحبا' }, { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3]) }]));
  assert.deepEqual([...zip.keys()], ['a.txt', 'dir/b.bin']);
  assert.equal(new TextDecoder().decode(await zip.get('a.txt')()), 'مرحبا');
});

test('zip + Word: reads a real (deflated) .docx made by python-docx', async () => {
  const bytes = new Uint8Array(await readFile(new URL('./fixture-word.docx', import.meta.url)));
  const lines = await processing.extractDocxText(bytes);
  assert.deepEqual(lines, ['مرحبا بكم في ملف وورد', 'السطر الثاني & رموز <خاصة>']);
});

test('Word export: right-to-left paragraphs, escaped text, disclaimer, and it reads back', async () => {
  const bytes = buildDocx({ title: 'عقد إيجار', body: '# عقد إيجار\n## البند الأول\n1. الأجرة <45,000> ريال\n- لا تأجير من الباطن\n**مهم** جداً', disclaimer: 'تنبيه قانوني' });
  const xml = new TextDecoder().decode(await readZip(bytes).get('word/document.xml')());
  assert.match(xml, /<w:bidi\/>/);
  assert.match(xml, /<w:rtl\/>/);
  assert.match(xml, /&lt;45,000&gt;/);
  assert.match(xml, /<w:b\/><w:bCs\/>.*مهم/);
  const lines = await processing.extractDocxText(bytes);
  assert.equal(lines[0], 'عقد إيجار');
  assert.ok(lines.includes('1. الأجرة <45,000> ريال'));
  assert.equal(lines.at(-1), 'تنبيه قانوني');
  assert.equal(lines.filter((l) => l === 'عقد إيجار').length, 1, 'the title is not repeated');
});

// ---------------------------------------------------------------- local search
test('local search finds the right page despite Arabic spelling variants', () => {
  const pages = ['مقدمة عن الكتاب وأهدافه.', 'الفصل الثاني يتناول عقود الإيجار والتزامات المستأجر.', 'الفصل الثالث عن البيع والشراء.'];
  const chunks = chunkPages(pages);
  assert.equal(chunks.length, 3);
  const results = searchChunks(chunks, 'وش التزامات المستاجر في الايجار؟');
  assert.equal(results[0].page, 2);
  assert.equal(normalizeArabic('إيجارٌ'), 'ايجار');
});

test('page numbers are understood in Arabic and Latin digits', () => {
  assert.deepEqual(attachments.pagesMentioned('اشرح الصفحة ١٢'), [12]);
  assert.deepEqual(attachments.pagesMentioned('ترجم صفحة 3 و4'), [3, 4]);
  assert.deepEqual(attachments.pagesMentioned('ص 5-7'), [5, 6, 7]);
  assert.deepEqual(attachments.pagesMentioned('لخص الملف'), []);
});

// ---------------------------------------------------------------- documents
test('voice requests open the right template; every template has questions', () => {
  assert.equal(templateFromRequest('اكتب لي عقد إيجار لشقتي')?.id, 'lease');
  assert.equal(templateFromRequest('ابي عقد بيع سيارة')?.id, 'sale');
  assert.equal(templateFromRequest('جهز لي سيرة ذاتية')?.id, 'cv');
  assert.equal(templateFromRequest('كيف الجو اليوم؟'), null);
  for (const template of DOCUMENT_TEMPLATES) assert.ok(template.fields.length >= 3 && template.fields.every((f) => f.question));
});

test('file passages become a capped, page-labelled prompt', () => {
  const prompt = documentContextToPrompt({ name: 'كتاب', pageCount: 90, passages: [{ page: 3, text: 'نص' }, { page: 9, text: 'x'.repeat(20_000) }] });
  assert.match(prompt, /«كتاب» \(90 صفحة\)/);
  assert.match(prompt, /\[ص3\] نص/);
  assert.ok(prompt.length < 13_000);
  assert.equal(documentContextToPrompt(null), '');
});

// ---------------------------------------------------------------- vision
test('vision falls through providers and sends images as data URLs', async () => {
  process.env.GROQ_API_KEY = 'g';
  process.env.GEMINI_API_KEY = 'm';
  delete process.env.OPENROUTER_API_KEY;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).includes('groq')) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'المبلغ 230 ريال' } }] }) };
  };
  const result = await analyzeImages({ question: 'كم المبلغ؟', images: ['QUJD'.repeat(40)] });
  assert.equal(result.provider, 'gemini');
  assert.equal(calls[1].body.messages.at(-1).content[1].image_url.url.slice(0, 23), 'data:image/jpeg;base64,');
});

// ---------------------------------------------------------------- study
test('study results are validated: bad quiz items are dropped', () => {
  const quiz = normalizeStudyResult('quiz', { questions: [
    { type: 'mcq', question: 'س1', options: ['أ', 'ب', 'ج'], answer: 1, explanation: 'لأن' },
    { type: 'mcq', question: 'بلا خيارات', options: [], answer: 0 },
    { type: 'tf', question: 'س2', answer: 'صح' },
    { type: 'short', question: 'س3', answer: '' },
  ] });
  assert.equal(quiz.questions.length, 2);
  assert.equal(quiz.questions[1].answer, true);
  assert.deepEqual(normalizeStudyResult('summary', { points: ['نقطة', { text: 'ثانية', page: 4 }] }).points, [{ text: 'نقطة', page: undefined }, { text: 'ثانية', page: 4 }]);
});

test('long scopes: batching and even sampling stay under the limits', () => {
  const chunks = Array.from({ length: 100 }, (_, i) => ({ page: i + 1, text: 'ن'.repeat(800) }));
  const batches = study.batchChunks(chunks, 10_000);
  assert.ok(batches.every((b) => b.reduce((s, c) => s + c.text.length, 0) <= 10_000));
  assert.equal(batches.flat().length, 100);
  const sample = study.sampleEvenly(chunks, 12_000);
  assert.ok(sample.length <= 15 && sample[0].page === 1 && sample.at(-1).page > 80);
});

test('SM-2: 1 day, 6 days, then growing; a lapse resets to 10 minutes', () => {
  const now = 0;
  let review = newReview('c', 's', now);
  review = reviewCard(review, 4, now);
  assert.equal(review.interval, 1);
  review = reviewCard(review, 4, now);
  assert.equal(review.interval, 6);
  review = reviewCard(review, 5, now);
  assert.ok(review.interval >= 15);
  review = reviewCard(review, 0, now);
  assert.equal(review.interval, 0);
  assert.equal(review.due, 10 * 60 * 1000);
  assert.ok(review.ease >= 1.3);
});

test('spoken quiz: ordinals, true/false, short answers, and a full session', () => {
  const mcq = { type: 'mcq', question: 'ق', options: ['الرياض', 'جدة', 'الدمام'], answer: 1 };
  assert.equal(gradeAnswer(mcq, 'الثاني'), true);
  assert.equal(gradeAnswer(mcq, 'جده'), true);
  assert.equal(gradeAnswer(mcq, 'الأول'), false);
  assert.equal(gradeAnswer({ type: 'tf', answer: false }, 'خطأ'), true);
  assert.equal(gradeAnswer({ type: 'short', answer: 'التمثيل الضوئي في النبات' }, 'هو التمثيل الضوئي للنبات'), true);

  let state = null;
  const first = startVoiceQuiz([mcq, { type: 'tf', question: 'ص', answer: true, explanation: 'لأن' }], (s) => { state = s; });
  assert.match(first, /السؤال 1 من 2/);
  assert.match(answerVoiceQuiz('جدة'), /^صح\..*السؤال 2 من 2/);
  assert.match(answerVoiceQuiz('خطأ'), /الإجابة الصحيحة: صح.*نتيجتك 1 من 2/);
  assert.equal(state.finished, true);
});
