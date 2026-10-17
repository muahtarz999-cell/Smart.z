import assert from 'node:assert/strict';
import test from 'node:test';
import { planSendCommand } from '../lib/whatsapp-commands.js';
import { WHATSAPP_SEND_TOOL } from '../lib/assistant-response.js';

const search = async (name) => [{ jid: '966500000000@s.whatsapp.net', name, isGroup: false }];

test('a voice message request becomes a voice send; plain sends stay text', async () => {
  assert.ok(WHATSAPP_SEND_TOOL.function.parameters.properties.as_voice);
  const voice = await planSendCommand({ recipients: ['أحمد'], message: 'بتأخر نص ساعة', as_voice: true }, search);
  assert.equal(voice.action.asVoice, true);
  assert.match(voice.reply, /رسالة صوتية/);
  const text = await planSendCommand({ recipients: ['أحمد'], message: 'هلا' }, search);
  assert.equal(text.action.asVoice, false);
  const doc = await planSendCommand({ recipients: ['أحمد'], message: 'تفضل', as_voice: true, attach_document: 'العقد' }, search);
  assert.equal(doc.action.asVoice, false, 'a document is never turned into a voice note');
});
