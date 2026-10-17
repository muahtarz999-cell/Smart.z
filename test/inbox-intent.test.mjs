import assert from 'node:assert/strict';
import test from 'node:test';
import { inboxContextToPrompt, isInboxQuestion } from '../lib/whatsapp-inbox.js';

// Phrasings users actually say, including Whisper spellings ("الغير مقروءة", "رسايل", "الواتساب").
test('spoken requests to look at WhatsApp messages attach the inbox', () => {
  for (const q of [
    'اطلع على الرسائل غير المقروءة', 'اطّلع على الرسائل الغير مقروءة', 'هل عندي رسائل غير مقروءة؟',
    'وش الرسائل اللي ما قريتها', 'شوف الواتس', 'افتح الواتساب وشوف الرسائل', 'عندي رسايل جديدة؟',
    'اقرأ لي الرسائل', 'في أحد راسلني؟', 'هل فيه رسائل جديدة في الواتساب', 'اعرض رسائل الواتس',
    'لخص رسائلي', 'مين كلمني اليوم؟', 'وش وصلني في الواتس', 'من راسلني أمس',
  ]) assert.ok(isInboxQuestion(q), q);
});

test('sending, replying and unrelated requests do not', () => {
  for (const q of [
    'أرسل لأحمد إني بتأخر', 'ابعث رسالة لأمي', 'أرسل رسالة صوتية لأحمد', 'رد على أحمد قل له جاي',
    'اكتب رسالة لمديري أعتذر فيها', 'كم الساعة', 'شغل وضع القيادة', '',
  ]) assert.ok(!isInboxQuestion(q), q);
});

test('the assistant is told it cannot know which messages were read', () => {
  const prompt = inboxContextToPrompt({ count: 1, lines: ['[الأحد 9:00 م] أحمد: وينك؟'] });
  assert.match(prompt, /غير المقروءة/);
  assert.match(prompt, /أحمد: وينك؟/);
});

test('a waking WhatsApp server is never reported as "no messages"', () => {
  const empty = inboxContextToPrompt({ count: 0, lines: [], waking: true });
  assert.match(empty, /يستيقظ/);
  assert.match(empty, /بعد دقيقة/);
  assert.doesNotMatch(empty, /أخبره بذلك بإيجاز/);

  const some = inboxContextToPrompt({ count: 1, lines: ['[الأحد 9:00 م] أحمد: وينك؟'], waking: true });
  assert.match(some, /أحمد: وينك؟/);
  assert.match(some, /يستيقظ/);

  assert.doesNotMatch(inboxContextToPrompt({ count: 1, lines: ['[الأحد 9:00 م] أحمد: وينك؟'] }), /يستيقظ/);
});

test('an unlinked number is told to link WhatsApp, not that there are no messages', () => {
  const prompt = inboxContextToPrompt({ count: 0, lines: [], linked: false });
  assert.match(prompt, /غير مربوط/);
  assert.doesNotMatch(prompt, /لا توجد رسائل محفوظة/);
});
