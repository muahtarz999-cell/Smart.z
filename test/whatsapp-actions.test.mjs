import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { mock } from 'node:test';
import { isReplyAllowed, wantsVoiceReply } from '../lib/whatsapp-reply-rules.js';
import { planSendCommand } from '../lib/whatsapp-commands.js';
import { generateAssistantTurn, WHATSAPP_SEND_TOOL } from '../lib/assistant-response.js';
import { ContactBook } from '../services/render-baileys-node/contacts.js';

// ---------------------------------------------------------------- reply rules
test('auto-reply rules: off, everyone, allowlist (any number format), voice mode', () => {
  assert.equal(isReplyAllowed({ auto_reply_enabled: false }, '966500000001'), false);
  assert.equal(isReplyAllowed({ auto_reply_enabled: true }, '966500000001@s.whatsapp.net'), true);
  const tenant = { auto_reply_enabled: true, reply_scope: 'allowlist', allowed_numbers: ['+966 50 000 0001'] };
  assert.equal(isReplyAllowed(tenant, '966500000001@s.whatsapp.net'), true);
  assert.equal(isReplyAllowed(tenant, '966500000002'), false);
  assert.equal(wantsVoiceReply({ voice_reply_mode: 'match' }, true), true);
  assert.equal(wantsVoiceReply({ voice_reply_mode: 'match' }, false), false);
  assert.equal(wantsVoiceReply({ voice_reply_mode: 'voice' }, false), true);
  assert.equal(wantsVoiceReply({ voice_reply_mode: 'text' }, true), false);
  assert.equal(wantsVoiceReply({}, true), true, 'default is match');
});

// ---------------------------------------------------------------- planning a send
function bookSearch() {
  const book = new ContactBook({ supabase: null, nodeId: 1, dir: '/tmp' });
  book.save = async () => {};
  book.upsert([
    { id: '966500000001@s.whatsapp.net', name: 'أحمد الشغل' },
    { id: '966500000002@s.whatsapp.net', name: 'أحمد أخوي' },
    { id: '966500000003@s.whatsapp.net', name: 'أمي' },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `96650000010${i}@s.whatsapp.net`, name: `صديق ${i}` })),
  ]);
  book.addGroups([{ id: '1203@g.us', subject: 'العائلة' }]);
  return async (name, { groups }) => book.search(name, { groups });
}

test('a clear command becomes an action with no confirmation', async () => {
  const plan = await planSendCommand({ recipients: ['أمي'], message: 'جاي بالطريق' }, bookSearch());
  assert.equal(plan.reply, 'تم، أرسلت إلى أمي.');
  assert.deepEqual(plan.action.recipients.map((r) => r.jid), ['966500000003@s.whatsapp.net']);
  assert.equal(plan.action.requiresManualConfirmation, false);
});

test('two people with the same name: one short question, no action', async () => {
  const plan = await planSendCommand({ recipients: ['أحمد'], message: 'هلا' }, bookSearch());
  assert.match(plan.reply, /أكثر من «أحمد»/);
  assert.equal(plan.action, undefined);
});

test('unknown names are reported; groups are matched only when named as a group', async () => {
  assert.match((await planSendCommand({ recipients: ['سلطان'], message: 'هلا' }, bookSearch())).reply, /ما لقيت «سلطان»/);
  assert.match((await planSendCommand({ recipients: ['العائلة'], message: 'هلا' }, bookSearch())).reply, /ما لقيت/);
  const group = await planSendCommand({ recipients: ['العائلة'], message: 'هلا', to_group: true }, bookSearch());
  assert.equal(group.action.recipients[0].isGroup, true);
  assert.match(group.reply, /مجموعة العائلة/);
});

test('up to 5 people go out directly; more than 5 needs a manual tap', async () => {
  const five = await planSendCommand({ recipients: [0, 1, 2, 3, 4].map((i) => `صديق ${i}`), message: 'عيدكم مبارك' }, bookSearch());
  assert.equal(five.action.requiresManualConfirmation, false);
  const six = await planSendCommand({ recipients: [0, 1, 2, 3, 4, 5].map((i) => `صديق ${i}`), message: 'عيدكم مبارك' }, bookSearch());
  assert.equal(six.action.requiresManualConfirmation, true);
  assert.match(six.reply, /تأكيد الإرسال/);
});

// ---------------------------------------------------------------- tool calling
test('the assistant turn returns the tool call the model made', async () => {
  process.env.GROQ_API_KEY = 'g';
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: null, tool_calls: [{ function: { name: 'send_whatsapp_message', arguments: '{"recipients":["أمي"],"message":"جاي"}' } }] } }] }),
    };
  };
  const turn = await generateAssistantTurn('أرسل لأمي إني جاي', { tools: [WHATSAPP_SEND_TOOL] });
  assert.deepEqual(turn.toolCalls, [{ name: 'send_whatsapp_message', args: { recipients: ['أمي'], message: 'جاي' } }]);
  assert.equal(sent.tool_choice, 'auto');
  assert.match(sent.messages[0].content, /لا ترسل لمجموعة إلا/);
});

// ---------------------------------------------------------------- undo window
const source = (await readFile(new URL('../lib/send-actions.js', import.meta.url), 'utf8'))
  .replace("from './driving-commands'", `from '${new URL('../lib/driving-commands.js', import.meta.url).href}'`)
  // send-actions.js also imports ./speech (browser audio code); the undo-window tests only need its settings.
  .replace("import { getVoiceSettings } from './speech';", 'const getVoiceSettings = () => ({});');
const actions = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function setupActions(settings) {
  const store = new Map([['smartz-actions-v1', JSON.stringify(settings)]]);
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const sends = [];
  globalThis.fetch = async (_url, init) => {
    sends.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ success: true, sent: 1, failed: 0 }) };
  };
  actions.configureSendActions({ getAccessToken: async () => 't' });
  return sends;
}
const action = (n = 1, manual = false) => ({
  type: 'whatsapp_send', text: 'هلا', requiresManualConfirmation: manual,
  recipients: Array.from({ length: n }, (_, i) => ({ jid: `9665000000${i}@s.whatsapp.net`, name: `x${i}` })),
});

test('a clear send goes out after the undo window; "تراجع" during it cancels', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    let sends = setupActions({ undoSeconds: 3 });
    actions.queueSend(action());
    assert.equal(actions.getPendingSend().status, 'counting');
    mock.timers.tick(2000);
    assert.equal(actions.getPendingSend().secondsLeft, 1);
    mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sends.length, 1);
    assert.equal(sends[0].manualConfirmation, false);

    sends = setupActions({ undoSeconds: 3 });
    actions.queueSend(action());
    assert.equal(actions.isCancelCommand('تراجع'), true);
    assert.equal(actions.cancelPendingSend(), true);
    mock.timers.tick(5000);
    assert.equal(sends.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test('more than 5 people waits for the confirm tap, which is the only way to send it', async () => {
  const sends = setupActions({ undoSeconds: 5 });
  actions.queueSend(action(6, true));
  assert.equal(actions.getPendingSend().status, 'confirm');
  actions.confirmPendingSend();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].manualConfirmation, true);
});

test('undo set to 0 sends immediately; "confirm every send" always waits', async () => {
  let sends = setupActions({ undoSeconds: 0 });
  actions.queueSend(action());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  sends = setupActions({ undoSeconds: 5, confirmEverySend: true });
  actions.queueSend(action());
  assert.equal(actions.getPendingSend().status, 'confirm');
  assert.equal(sends.length, 0);
});
