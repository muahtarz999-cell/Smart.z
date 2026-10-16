import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInboxContext,
  inboxContextToPrompt,
  isInboxQuestion,
  normalizeRetentionDays,
  sanitizeInboxItems,
} from '../lib/whatsapp-inbox.js';
import { describeMessage, Inbox } from '../services/render-baileys-node/inbox.js';
import { generateAssistantTurn, WHATSAPP_SEND_TOOL } from '../lib/assistant-response.js';

test('recognises questions about received messages, not send requests', () => {
  for (const q of ['لخص رسائلي', 'مين كلمني اليوم؟', 'وش وصلني في الواتس', 'عطني تقرير عن رسائل الواتس', 'من راسلني أمس']) {
    assert.ok(isInboxQuestion(q), q);
  }
  for (const q of ['أرسل لأحمد إني بتأخر', 'كم الساعة', 'ابعث رسالة لأمي', '']) {
    assert.ok(!isInboxQuestion(q), q);
  }
});

test('node inbox keeps messages in memory until acknowledged, with age and size caps', () => {
  const inbox = new Inbox({ maxItems: 2, maxAgeMs: 1000 });
  assert.ok(inbox.add({ id: 'a', text: 'هلا' }, 0));
  assert.ok(!inbox.add({ id: 'a', text: 'مكرر' }, 0));
  inbox.add({ id: 'b', text: 'ثاني' }, 10);
  inbox.add({ id: 'c', text: 'ثالث' }, 20);
  assert.deepEqual(inbox.list(30).map((i) => i.id), ['b', 'c']);
  assert.equal(inbox.ack(['b', 'zzz']), 1);
  assert.deepEqual(inbox.list(30).map((i) => i.id), ['c']);
  assert.deepEqual(inbox.list(5000), []);
});

test('media messages get a readable label; protocol messages are skipped', () => {
  assert.equal(describeMessage({ message: { conversation: ' مرحبا ' } }), 'مرحبا');
  assert.equal(describeMessage({ message: { imageMessage: { caption: 'الفاتورة' } } }), 'صورة: الفاتورة');
  assert.equal(describeMessage({ message: { audioMessage: {} } }), 'رسالة صوتية');
  assert.equal(describeMessage({ message: { protocolMessage: {} } }), null);
});

test('items from the node are sanitised and the retention falls back to a week', () => {
  const [item] = sanitizeInboxItems([{ id: 'x', text: 'نص', senderNumber: '+966 50', sentAt: 5 }, { id: '', text: 'x' }, null]);
  assert.equal(item.senderNumber, '96650');
  assert.equal(sanitizeInboxItems('bad').length, 0);
  assert.equal(normalizeRetentionDays('14'), 14);
  assert.equal(normalizeRetentionDays('99'), 7);
});

test('the stored messages reach the assistant prompt', async () => {
  const context = buildInboxContext([
    { id: '1', text: 'وين وصلت؟', senderName: 'أحمد', sentAt: Date.UTC(2026, 9, 16, 15, 0) },
    { id: '2', text: 'الاجتماع بكرة', senderName: 'سارة', isGroup: true, chatName: 'العمل', sentAt: Date.UTC(2026, 9, 16, 16, 0) },
  ]);
  assert.equal(context.count, 2);
  assert.match(context.lines[1], /سارة في مجموعة «العمل»: الاجتماع بكرة/);
  assert.match(inboxContextToPrompt({ lines: [] }), /لا توجد رسائل محفوظة/);

  process.env.GROQ_API_KEY = 'g';
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'أحمد يسأل وين وصلت.' } }] }) };
  };
  const turn = await generateAssistantTurn('لخص رسائلي', { tools: [WHATSAPP_SEND_TOOL], inboxContext: context });
  assert.equal(turn.reply, 'أحمد يسأل وين وصلت.');
  assert.match(sent.messages[0].content, /أحمد: وين وصلت؟/);
  assert.match(sent.messages[0].content, /رقم WhatsApp الخاص بالمستخدم مربوط/);
});
