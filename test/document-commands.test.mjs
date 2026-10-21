import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanReplyForDocument, parseDocumentCommand, pickDocumentReply, titleFromBody } from '../lib/document-commands.js';

test('recognises save and download document commands', () => {
  assert.deepEqual(parseDocumentCommand('انقل العقد إلى المستندات'), { action: 'save', format: 'docx', source: 'reply', title: null });
  assert.deepEqual(parseDocumentCommand('احفظه في مستنداتي'), { action: 'save', format: 'docx', source: 'reply', title: null });
  assert.deepEqual(parseDocumentCommand('حمّل العقد PDF'), { action: 'download', format: 'pdf', source: 'reply', title: null });
  assert.equal(parseDocumentCommand('انقل الملف إلى المستندات').source, 'file');
});

test('does not intercept questions or ordinary writing requests', () => {
  assert.equal(parseDocumentCommand('كيف احفظ النص في المستندات'), null);
  assert.equal(parseDocumentCommand('اكتب لي عقد إيجار'), null);
  assert.equal(parseDocumentCommand('حمّل التطبيق على جوالي'), null);
});

test('selects and cleans the latest long assistant reply', () => {
  const body = `عقد إيجار سكني\n${'البند: يلتزم الطرفان بما اتفقا عليه. '.repeat(6)}`;
  assert.equal(pickDocumentReply([{ role: 'assistant', content: body }, { role: 'assistant', content: 'لا أستطيع ذلك.' }]), body.trim());
  assert.equal(cleanReplyForDocument('إليك العقد:\n\nعقد إيجار\nالبند الأول\nالبند الثاني\nهل تريد تعديلًا؟'), 'عقد إيجار\nالبند الأول\nالبند الثاني');
  assert.equal(titleFromBody('# عقد إيجار شقة\nالبند الأول'), 'عقد إيجار شقة');
});
