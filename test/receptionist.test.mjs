import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  buildAcceptBody,
  fallbackSummary,
  isVipCaller,
  parseSipHeaders,
  routingCandidates,
  sanitizeCallReport,
  sanitizeReceptionistSettings,
  settingsFromRow,
  summaryPrompt,
  verifyWebhookSignature,
} from '../lib/receptionist.js';
import { callingSettingsBody, sipServerConfig } from '../lib/whatsapp-calling.js';
import { mergeCustomerRows, validateAdminRequest } from '../lib/admin.js';
import { CallMonitor } from '../services/render-baileys-node/call-monitor.js';

const USER = '11111111-2222-4333-8444-555555555555';

// ---------------------------------------------------------------- settings

test('settings: cleaned, numbers normalized, unknown fields dropped', () => {
  const settings = sanitizeReceptionistSettings({
    enabled: true,
    ownerName: '  زياد  ',
    greeting: 'x'.repeat(400),
    vipNumbers: ['+966 50 123 4567', '966501234567', 'abc', '12'],
    transferNumber: '+966-55-000-1111',
    hacked: true,
  });
  assert.equal(settings.ownerName, 'زياد');
  assert.equal(settings.greeting.length, 300);
  assert.deepEqual(settings.vipNumbers, ['966501234567']);
  assert.equal(settings.transferNumber, '966550001111');
  assert.equal('hacked' in settings, false);
  assert.equal(settingsFromRow(null).enabled, false);
  assert.equal(settingsFromRow({ whatsapp_enabled: true }).whatsappEnabled, true);
});

test('VIP callers match local and international forms', () => {
  const settings = sanitizeReceptionistSettings({ vipNumbers: ['966501234567'] });
  assert.equal(isVipCaller(settings, '0501234567'), true);
  assert.equal(isVipCaller(settings, '966509999999'), false);
  assert.equal(isVipCaller(settings, ''), false);
});

// ---------------------------------------------------------------- routing

test('SIP headers: called number first, then where it was forwarded from', () => {
  const parsed = parseSipHeaders([
    { name: 'From', value: '"Ahmad" <sip:+966501112222@carrier.example>;tag=1' },
    { name: 'To', value: '<sip:+966114445555@sip.api.openai.com>' },
    { name: 'Diversion', value: '<tel:+966507778888>;reason=no-answer' },
  ]);
  assert.deepEqual(parsed, { to: '966114445555', from: '966501112222', diversion: ['966507778888'] });
  assert.deepEqual(routingCandidates(parsed), ['966114445555', '966507778888']);
  assert.deepEqual(parseSipHeaders(null), { to: null, from: null, diversion: [] });
});

// ---------------------------------------------------------------- webhook signature

function sign(secretBase64, id, timestamp, body) {
  return `v1,${createHmac('sha256', Buffer.from(secretBase64, 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

test('OpenAI webhook signature: valid, tampered, expired, whsec_ prefix', async () => {
  const secret = Buffer.from('a-very-secret-key-for-tests').toString('base64');
  const now = Date.parse('2026-10-22T12:00:00Z');
  const timestamp = String(Math.floor(now / 1000));
  const body = '{"type":"realtime.call.incoming"}';
  const signature = sign(secret, 'evt_1', timestamp, body);
  const base = { id: 'evt_1', timestamp, signature, body, now };
  assert.equal(await verifyWebhookSignature({ ...base, secret }), true);
  assert.equal(await verifyWebhookSignature({ ...base, secret: `whsec_${secret}` }), true);
  assert.equal(await verifyWebhookSignature({ ...base, signature: `v1,bad ${signature}` , secret }), true, 'any listed signature');
  assert.equal(await verifyWebhookSignature({ ...base, body: `${body} `, secret }), false);
  assert.equal(await verifyWebhookSignature({ ...base, secret, now: now + 10 * 60 * 1000 }), false);
  assert.equal(await verifyWebhookSignature({ ...base, signature: '', secret }), false);
});

// ---------------------------------------------------------------- accept body

test('accept body: instructions carry the owner rules; transfer only for phone calls with a number', () => {
  const settings = sanitizeReceptionistSettings({
    ownerName: 'زياد', greeting: 'أهلًا بك', knowledge: 'الدوام من ٩ إلى ٥', transferNumber: '966550001111',
  });
  const phone = buildAcceptBody(settings, { channel: 'phone', callerNumber: '966501112222', vip: true });
  assert.equal(phone.type, 'realtime');
  assert.equal(phone.model, 'gpt-realtime');
  assert.match(phone.instructions, /زياد/);
  assert.match(phone.instructions, /أهلًا بك/);
  assert.match(phone.instructions, /الدوام من ٩ إلى ٥/);
  assert.match(phone.instructions, /مساعد آلي/);
  assert.match(phone.instructions, /القائمة المهمة/);
  assert.deepEqual(phone.tools.map((tool) => tool.name), ['take_message', 'transfer_to_owner', 'end_call']);
  const whatsapp = buildAcceptBody(settings, { channel: 'whatsapp' });
  assert.deepEqual(whatsapp.tools.map((tool) => tool.name), ['take_message', 'end_call']);
  assert.match(whatsapp.instructions, /مكالمات واتساب/);
  const empty = buildAcceptBody(sanitizeReceptionistSettings({}), { channel: 'phone' });
  assert.match(empty.instructions, /لا تعطِ أي معلومة/);
  assert.equal(empty.tools.some((tool) => tool.name === 'transfer_to_owner'), false);
});

// ---------------------------------------------------------------- call report

test('call report: cleaned and capped; fallback summary without the model', () => {
  const report = sanitizeCallReport({
    callId: 'rtc_123',
    channel: 'phone',
    callerNumber: '+966501112222',
    transcript: [{ role: 'caller', text: 'أبي أكلم زياد' }, { role: 'system', text: 'x' }, ...Array.from({ length: 100 }, () => ({ role: 'assistant', text: 'ok' }))],
    messages: [{ caller_name: 'أحمد', message: 'يتصل بخصوص العقد', urgent: true, callback_number: '0501234567' }],
  });
  assert.equal(report.transcript.length, 80);
  assert.equal(report.callerNumber, '966501112222');
  assert.deepEqual(fallbackSummary(report), { summary: 'يتصل بخصوص العقد', callerName: 'أحمد', urgent: true });
  assert.match(summaryPrompt(report), /رسالة مسجّلة: أحمد — يتصل بخصوص العقد \(عاجل\)/);
  assert.equal(fallbackSummary(sanitizeCallReport({ callId: 'x' })).summary, 'مكالمة فائتة، لم يتكلم المتصل.');
});

// ---------------------------------------------------------------- WhatsApp business calling

test('WhatsApp calling settings for Meta', () => {
  assert.equal(sipServerConfig({}), null);
  assert.equal(sipServerConfig({ WHATSAPP_CALLS_SIP_HOST: 'not a host' }), null);
  const server = sipServerConfig({ WHATSAPP_CALLS_SIP_HOST: 'sip.provider.sa' });
  assert.deepEqual(server, { hostname: 'sip.provider.sa', port: '5061' });
  assert.deepEqual(callingSettingsBody(true, server).calling.sip.servers, [server]);
  assert.equal(callingSettingsBody(true, server).calling.status, 'ENABLED');
  assert.deepEqual(callingSettingsBody(false), { calling: { status: 'DISABLED' } });
});

// ---------------------------------------------------------------- admin

test('admin assigns provider numbers', () => {
  const ok = validateAdminRequest({ action: 'set_receptionist_numbers', userId: USER, numbers: ['+966 11 444 5555', '966114445555'] }, 'admin');
  assert.deepEqual(ok, { ok: true, action: 'set_receptionist_numbers', userId: USER, numbers: ['966114445555'] });
  assert.equal(validateAdminRequest({ action: 'set_receptionist_numbers', userId: USER, numbers: ['123'] }, 'admin').ok, false);
  assert.equal(validateAdminRequest({ action: 'set_receptionist_numbers', userId: USER, numbers: [], extra: 1 }, 'admin').ok, false);
  const rows = mergeCustomerRows([{ id: USER, email: 'a@b.io' }], [], [], null, [
    { user_id: USER, number: '966114445555', channel: 'phone' },
    { user_id: USER, number: '966500000000', channel: 'whatsapp' },
  ]);
  assert.deepEqual(rows[0].receptionistNumbers, ['966114445555']);
});

// ---------------------------------------------------------------- the Render call monitor

test('call monitor: tools answer the model, the call is reported once', async () => {
  const reports = [];
  const calls = [];
  const monitor = new CallMonitor({ apiKey: 'test', logger: { warn() {}, error() {} }, report: async (payload) => reports.push(payload) });
  monitor.callApi = async (session, action, body) => { calls.push({ action, body }); return true; };
  const sent = [];
  const session = {
    callId: 'rtc_1', userId: USER, channel: 'phone', callerNumber: '966501112222', transferNumber: '966550001111',
    startedAt: new Date().toISOString(), transcript: [], messages: [], transferred: false, finished: false,
    socket: { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)), close() {} },
  };
  monitor.active.set('rtc_1', session);

  await monitor.onEvent(session, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'السلام عليكم' });
  await monitor.onEvent(session, { type: 'response.output_audio_transcript.done', transcript: 'وعليكم السلام' });
  await monitor.onEvent(session, { type: 'response.function_call_arguments.done', name: 'take_message', call_id: 'c1', arguments: '{"message":"اتصل بي","urgent":true}' });
  await monitor.onEvent(session, { type: 'response.function_call_arguments.done', name: 'transfer_to_owner', call_id: 'c2', arguments: '{"reason":"طارئ"}' });

  assert.deepEqual(session.transcript.map((line) => line.role), ['caller', 'assistant']);
  assert.equal(session.messages[0].message, 'اتصل بي');
  assert.deepEqual(calls, [{ action: 'refer', body: { target_uri: 'tel:+966550001111' } }]);
  assert.equal(session.transferred, true);
  assert.equal(sent.filter((event) => event.type === 'conversation.item.create').length, 2);
  assert.equal(sent.filter((event) => event.type === 'response.create').length, 2);

  await monitor.finish(session);
  await monitor.finish(session);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].messages.length, 1);
  assert.equal(monitor.active.size, 0);
});

// ---------------------------------------------------------------- wiring

test('wiring: webhook verifies, routes by number and declines the unknown; node and disconnect hooks', async () => {
  const webhook = await readFile(new URL('../app/api/voice/openai/webhook/route.js', import.meta.url), 'utf8');
  assert.match(webhook, /verifyWebhookSignature/);
  assert.match(webhook, /INVALID_SIGNATURE/);
  assert.match(webhook, /findReceptionistOwner\(service, routingCandidates\(sip\)\)/);
  assert.match(webhook, /openai\(callId, 'reject'/);
  assert.match(webhook, /\/api\/calls\/monitor/);
  const node = await readFile(new URL('../services/render-baileys-node/index.js', import.meta.url), 'utf8');
  assert.match(node, /app\.post\('\/api\/calls\/monitor'/);
  assert.match(node, /\/api\/receptionist\/call-log/);
  const disconnect = await readFile(new URL('../app/api/whatsapp/connection/route.js', import.meta.url), 'utf8');
  assert.match(disconnect, /setMetaCalling\(connection, false\)/);
  const migration = await readFile(new URL('../supabase/migrations/202610220003_ai_receptionist.sql', import.meta.url), 'utf8');
  for (const table of ['ai_receptionist_settings', 'ai_receptionist_numbers', 'ai_call_logs']) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
});
