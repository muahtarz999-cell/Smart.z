import test from 'node:test';
import assert from 'node:assert/strict';
import { callLines, isDaySummaryRequest, periodRange, receptionistLines, redactSecrets, sanitizeSummaryContext, smsLines, summaryContextToPrompt, summaryPeriod } from '../lib/day-summary.js';
import { commitmentLines, commitmentsContextToPrompt, commitmentsFromModel, extractionLines, isCommitmentQuestion, isExpired, looksLikeCommitment, COMMITMENT_TTL_AFTER_DUE_MS, COMMITMENT_TTL_WITHOUT_DUE_MS } from '../lib/commitments.js';
import { buildInboxContext, sanitizeInboxItems } from '../lib/whatsapp-inbox.js';

test('day summary requests are recognised, others are not', () => {
  for (const text of ['لخص يومي', 'لخّص لي يومي', 'ملخص اليوم', 'وش فاتني اليوم؟', 'ملخص امس', 'ايش فاتني']) assert.equal(isDaySummaryRequest(text), true, text);
  for (const text of ['لخص هذا الملف', 'كيف الجو اليوم', 'ارسل لاحمد', '']) assert.equal(isDaySummaryRequest(text), false, text);
  assert.equal(summaryPeriod('ملخص أمس'), 'yesterday');
  assert.equal(summaryPeriod('لخص يومي'), 'today');
});

test('period range is midnight to now in Riyadh time', () => {
  const now = Date.parse('2026-10-22T12:00:00Z'); // 15:00 Riyadh
  const today = periodRange('today', now, -180);
  assert.equal(new Date(today.from).toISOString(), '2026-10-21T21:00:00.000Z');
  const yesterday = periodRange('yesterday', now, -180);
  assert.equal(yesterday.to, today.from);
  assert.equal(yesterday.to - yesterday.from, 86_400_000);
});

test('verification codes are masked, normal numbers kept', () => {
  assert.equal(redactSecrets('رمز التحقق 482913 لا تشاركه'), 'رمز التحقق •••• لا تشاركه');
  assert.equal(redactSecrets('الاجتماع الساعة 5'), 'الاجتماع الساعة 5');
  assert.match(smsLines([{ address: 'Bank', body: 'Your code is 123456', date: 1 }])[0], /••••/);
});

test('call and receptionist lines', () => {
  const lines = callLines([{ name: 'أحمد', type: 'missed', duration: 0, date: 2 }, { number: '055', type: 'outgoing', duration: 180, date: 1 }, { type: 'weird' }]);
  assert.deepEqual(lines, ['مكالمة صادرة: 055 (3 د)', 'مكالمة فائتة: أحمد']);
  const range = { from: 100, to: Date.parse('2030-01-01') };
  const rec = receptionistLines([{ caller_name: 'سعد', summary: 'يريد موعد', urgent: true, created_at: '2026-10-22T08:00:00Z' }, { created_at: '1970-01-01T00:00:00Z' }], range);
  assert.equal(rec.length, 1);
  assert.match(rec[0], /عاجل/);
});

test('summary prompt is sanitised and bounded', () => {
  const big = Array.from({ length: 500 }, (_, i) => `سطر ${i} ${'x'.repeat(390)}`);
  const prompt = summaryContextToPrompt({ period: 'today', whatsapp: big, sms: [5, 'ok'], unavailable: ['SMS'] });
  assert.ok(prompt.length < 16_000);
  assert.match(prompt, /رسائل SMS \(1\)/);
  assert.match(prompt, /لم يمكن الوصول إلى: SMS/);
  assert.equal(sanitizeSummaryContext({ period: 'x' }).period, 'today');
});

test('outgoing messages reach the commitments filter but never the inbox context', () => {
  const now = Date.now();
  const items = sanitizeInboxItems([
    { id: 'a', chatJid: '1@s.whatsapp.net', senderName: 'أحمد', text: 'تمام أرسل لك العقد بكره', sentAt: now, outgoing: true },
    { id: 'b', chatJid: '2@s.whatsapp.net', senderName: 'سارة', text: 'مرحبا كيفك', sentAt: now },
  ]);
  assert.equal(items.find((i) => i.id === 'a').outgoing, true);
  const context = buildInboxContext(items, { now });
  assert.equal(context.count, 1);
  assert.ok(!context.lines.join('\n').includes('العقد'));
  const lines = extractionLines(items);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /أنا ← أحمد/);
});

test('commitment records expire on their own', () => {
  const now = Date.parse('2026-10-22T09:00:00Z');
  const records = commitmentsFromModel({ items: [
    { person: 'أحمد', what: 'يرسل العقد', direction: 'mine', due: '2026-10-23T15:00:00+03:00' },
    { person: 'خالد', what: 'يحوّل المبلغ', direction: 'theirs', due: '' },
    { what: '' },
  ] }, now);
  assert.equal(records.length, 2);
  assert.equal(records[0].expiresAt, Date.parse('2026-10-23T12:00:00Z') + COMMITMENT_TTL_AFTER_DUE_MS);
  assert.equal(records[1].expiresAt, now + COMMITMENT_TTL_WITHOUT_DUE_MS);
  assert.equal(records[0].id, commitmentsFromModel({ items: [{ person: 'أحمد', what: 'يرسل العقد' }] }, now)[0].id);
  assert.equal(isExpired(records[1], now + COMMITMENT_TTL_WITHOUT_DUE_MS + 1), true);
  const lines = commitmentLines(records, { now });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /وعدتَ أحمد أن يرسل العقد/);
  assert.equal(commitmentLines(records, { now, dueBy: now }).length, 0);
});

test('commitment questions and prompt', () => {
  for (const text of ['وش وعدت أحد؟', 'وش علي اليوم', 'هل نسيت شي؟', 'مين ينتظرني']) assert.equal(isCommitmentQuestion(text), true, text);
  assert.equal(isCommitmentQuestion('كيف الطقس'), false);
  assert.equal(looksLikeCommitment('ابشر بكره ارسله'), true);
  assert.equal(looksLikeCommitment('هههه'), false);
  assert.match(commitmentsContextToPrompt([]), /لا توجد ملاحظات/);
  assert.match(commitmentsContextToPrompt(['وعدتَ أحمد أن يرسل العقد']), /بصدق/);
});
