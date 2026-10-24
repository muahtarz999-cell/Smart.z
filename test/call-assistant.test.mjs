import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  decideWhatsAppCall,
  DEFAULT_CALL_MESSAGE,
  DRIVING_CALL_MESSAGE,
  internationalNumber,
  parseCallCommand,
  whatsAppJidFor,
} from '../lib/call-rules.js';
import { planCallControl, runDriveTurn } from '../lib/drive-turn.js';

// ---------------------------------------------------------------- voice commands while ringing

test('parseCallCommand: answer', () => {
  for (const said of ['رد', 'رُد', 'رد عليه', 'ايوه رد', 'افتح الخط', 'اقبل المكالمة', 'جاوبه.']) {
    assert.deepEqual(parseCallCommand(said), { decision: 'answer' }, said);
  }
});

test('parseCallCommand: reject', () => {
  for (const said of ['ارفض', 'أرفض', 'سكر', 'سكّر عليه', 'اقفل الخط', 'كنسل', 'طنشه', 'لا ترد']) {
    assert.deepEqual(parseCallCommand(said), { decision: 'reject' }, said);
  }
});

test('parseCallCommand: reject with the driver\'s own message', () => {
  assert.deepEqual(parseCallCommand('ارفض وقل له إني أسوق وبتصل عليه بعدين', { driving: true }), {
    decision: 'reject_message', message: 'أنا أسوق وبتصل عليه بعدين',
  });
  assert.deepEqual(parseCallCommand('قل له اني في اجتماع'), { decision: 'reject_message', message: 'أنا في اجتماع' });
  assert.deepEqual(parseCallCommand('ارفض برسالة', { driving: true }), { decision: 'reject_message', message: DRIVING_CALL_MESSAGE });
  assert.deepEqual(parseCallCommand('سكر وأرسل له رسالة'), { decision: 'reject_message', message: DEFAULT_CALL_MESSAGE });
});

test('parseCallCommand: ordinary sentences are not call commands', () => {
  for (const said of ['رد على رسالة أحمد', 'كم الساعة', 'ارفض الطلب اللي أرسلته أمس في الإيميل وقل لهم السبب بالتفصيل الممل'.repeat(4), '']) {
    assert.equal(parseCallCommand(said), null, said.slice(0, 30));
  }
});

// ---------------------------------------------------------------- numbers

test('internationalNumber / whatsAppJidFor', () => {
  assert.equal(internationalNumber('0501234567', 'sa'), '966501234567');
  assert.equal(internationalNumber('+971 50 123 4567'), '971501234567');
  assert.equal(internationalNumber('00966501234567'), '966501234567');
  assert.equal(internationalNumber('0101234567', 'eg'), '20101234567');
  assert.equal(internationalNumber('123'), null);
  assert.equal(whatsAppJidFor('0501234567', 'sa'), '966501234567@s.whatsapp.net');
  assert.equal(whatsAppJidFor('', 'sa'), null);
});

// ---------------------------------------------------------------- WhatsApp calls

test('decideWhatsAppCall: off by default, on when enabled, always on while driving', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  assert.deepEqual(decideWhatsAppCall({}, now), { reject: false, message: null });
  assert.deepEqual(decideWhatsAppCall(null, now), { reject: false, message: null });
  assert.deepEqual(decideWhatsAppCall({ call_reject_enabled: true }, now), { reject: true, message: DEFAULT_CALL_MESSAGE });
  assert.deepEqual(decideWhatsAppCall({ call_reject_enabled: true, call_reject_message: ' في اجتماع ' }, now), { reject: true, message: 'في اجتماع' });
  assert.deepEqual(decideWhatsAppCall({ driving_until: '2026-10-22T13:00:00Z' }, now), { reject: true, message: DRIVING_CALL_MESSAGE });
  assert.deepEqual(decideWhatsAppCall({ driving_until: '2026-10-22T11:00:00Z' }, now), { reject: false, message: null }, 'expired flag');
});

// ---------------------------------------------------------------- driving mode

const ringingCall = { number: '0501234567', name: 'أحمد', countryIso: 'sa' };

function deps(transcript, { linked = true } = {}) {
  const calls = { assistant: 0 };
  return {
    calls,
    deps: {
      transcribe: async () => transcript,
      assistantTurn: async () => { calls.assistant += 1; return { reply: 'رد عادي', toolCalls: [] }; },
      sendTool: { name: 'send_whatsapp_message' },
      planSend: linked ? async () => ({ reply: '' }) : null,
      synthesize: async () => ({ audio: new Uint8Array([1]), contentType: 'audio/wav' }),
    },
  };
}

test('drive turn: «رد» while ringing answers without asking the assistant', async () => {
  const { deps: d, calls } = deps('رد');
  const result = await runDriveTurn({ audio: {}, context: { ringingCall } }, d);
  assert.equal(result.kind, 'call_control');
  assert.deepEqual(result.action, { type: 'call_control', decision: 'answer' });
  assert.equal(result.actionDelivery, 'service');
  assert.equal(calls.assistant, 0);
});

test('drive turn: reject with message goes by WhatsApp when linked', async () => {
  const { deps: d } = deps('ارفض وقل له إني أسوق');
  const result = await runDriveTurn({ audio: {}, context: { ringingCall } }, d);
  assert.deepEqual(result.action, {
    type: 'call_control', decision: 'reject_message', message: 'أنا أسوق', jid: '966501234567@s.whatsapp.net', name: 'أحمد',
  });
  const unlinked = await runDriveTurn({ audio: {}, context: { ringingCall } }, deps('ارفض وقل له إني أسوق', { linked: false }).deps);
  assert.deepEqual(unlinked.action, { type: 'call_control', decision: 'reject' });
  assert.match(unlinked.reply, /يحتاج ربط واتساب/);
});

test('drive turn: «رد» with nothing ringing is a normal sentence', async () => {
  const { deps: d, calls } = deps('رد');
  const result = await runDriveTurn({ audio: {}, context: {} }, d);
  assert.equal(result.kind, 'reply');
  assert.equal(calls.assistant, 1);
});

test('planCallControl: plain reject', () => {
  assert.deepEqual(planCallControl({ decision: 'reject' }, ringingCall, true), {
    reply: 'رفضت المكالمة.', action: { type: 'call_control', decision: 'reject' },
  });
});

// ---------------------------------------------------------------- wiring

test('wiring: node asks the app, settings and migration carry the call rules', async () => {
  const node = await readFile(new URL('../services/render-baileys-node/index.js', import.meta.url), 'utf8');
  assert.match(node, /sock\.ev\.on\('call'/);
  assert.match(node, /\/api\/whatsapp\/cluster\/call/);
  assert.match(node, /sock\.rejectCall\(call\.id, from\)/);
  const settings = await readFile(new URL('../app/api/whatsapp/cluster/settings/route.js', import.meta.url), 'utf8');
  assert.match(settings, /changes\.call_reject_enabled = body\.callReject/);
  assert.match(settings, /changes\.driving_until/);
  const migration = await readFile(new URL('../supabase/migrations/202610220002_whatsapp_call_rules.sql', import.meta.url), 'utf8');
  for (const column of ['call_reject_enabled', 'call_reject_message', 'driving_until']) assert.match(migration, new RegExp(`add column if not exists ${column}`));
  const callRoute = await readFile(new URL('../app/api/whatsapp/cluster/call/route.js', import.meta.url), 'utf8');
  assert.match(callRoute, /UNAUTHORIZED_CLUSTER_NODE/);
});

test('wiring: Android receiver, permissions, plugin and driving pause', async () => {
  const base = '../android/app/src/main/';
  const manifest = await readFile(new URL(`${base}AndroidManifest.xml`, import.meta.url), 'utf8');
  for (const permission of ['READ_PHONE_STATE', 'READ_CALL_LOG', 'ANSWER_PHONE_CALLS']) assert.match(manifest, new RegExp(`android\\.permission\\.${permission}`));
  assert.match(manifest, /\.calls\.IncomingCallReceiver[\s\S]*?android\.intent\.action\.PHONE_STATE/);
  const main = await readFile(new URL(`${base}java/com/smartz/assistant/MainActivity.java`, import.meta.url), 'utf8');
  assert.match(main, /registerPlugin\(CallAssistantPlugin\.class\)/);
  const service = await readFile(new URL(`${base}java/com/smartz/assistant/driving/DrivingModeService.java`, import.meta.url), 'utf8');
  assert.match(service, /CallAssistant\.isInCall\(\)/);
  assert.match(service, /"ringingCall"/);
  assert.match(service, /executeCallControl\(action\)/);
  const assistant = await readFile(new URL(`${base}java/com/smartz/assistant/calls/CallAssistant.java`, import.meta.url), 'utf8');
  assert.match(assistant, /boolean driving = DrivingModeService\.isRunning\(\);\s+if \(!driving && !isEnabled\(app\)\)/);
});
