import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  planComputerTask,
  planPhoneAction,
  planPhoneControl,
  sanitizeCapabilities,
  nowInstruction,
  COMPUTER_TASK_TOOL,
  PHONE_ACTION_TOOL,
} from '../lib/assistant-tools.js';
import { validateComputerTask, COMPUTER_TASK_TYPES } from '../lib/computer-task-validation.mjs';
import { buildTaskPayload, summarizeComputerResult, describeComputerTask, taskNeedsRoot } from '../lib/computer-tasks-client.js';

const root = 'C:\\Users\\Ziyad\\Documents';

// ---------------------------------------------------------------- validation of the new computer task types

test('computer validation: new action types need only their name/url, never a path or command line', () => {
  assert.equal(validateComputerTask('open_url', { url: 'https://example.com/a?b=1' }), null);
  assert.equal(validateComputerTask('open_app', { appName: 'الوورد' }), null);
  assert.equal(validateComputerTask('run_command', { commandName: 'نسخ احتياطي' }), null);
  assert.equal(validateComputerTask('open_file', { authorizedRoot: root, path: 'Reports\\2026.pdf' }), null);

  assert.notEqual(validateComputerTask('open_url', { url: 'file:///C:/Windows/System32/cmd.exe' }), null);
  assert.notEqual(validateComputerTask('open_url', { url: 'javascript:alert(1)' }), null);
  assert.notEqual(validateComputerTask('open_app', { appName: 'x', path: 'C:\\evil.exe' }), null);
  assert.notEqual(validateComputerTask('run_command', { commandName: 'x', arguments: '/c del' }), null);
  assert.notEqual(validateComputerTask('run_command', { commandName: '' }), null);
  assert.notEqual(validateComputerTask('open_file', { authorizedRoot: root, path: 'tools\\setup.exe' }), null);
  assert.notEqual(validateComputerTask('open_file', { authorizedRoot: root, path: 'run.PS1' }), null);
  assert.notEqual(validateComputerTask('open_file', { authorizedRoot: root, path: '..\\..\\Windows\\win.ini' }), null);
  assert.notEqual(validateComputerTask('shell', { command: 'dir' }), null);
});

test('computer validation: the original four types still need an authorized folder', () => {
  assert.notEqual(validateComputerTask('list_files', {}), null);
  assert.equal(COMPUTER_TASK_TYPES.length, 8);
});

test('migration allows exactly the validated task types', async () => {
  const migration = await readFile(new URL('../supabase/migrations/202610220001_computer_actions.sql', import.meta.url), 'utf8');
  for (const type of COMPUTER_TASK_TYPES) assert.match(migration, new RegExp(`'${type}'`));
  assert.match(migration, /^begin;$/m);
  assert.match(migration, /^commit;$/m);
  assert.match(migration, /create or replace function public\.create_computer_task_with_approval/);
});

// ---------------------------------------------------------------- planComputerTask (assistant tool → task)

test('planComputerTask: builds payloads with the remembered folder', () => {
  assert.deepEqual(planComputerTask({ action: 'search_files', query: 'فاتورة' }, { authorizedRoot: root }), {
    taskType: 'search_files', payload: { authorizedRoot: root, query: 'فاتورة' },
  });
  assert.deepEqual(planComputerTask({ action: 'open_app', name: 'الوورد' }), { taskType: 'open_app', payload: { appName: 'الوورد' } });
  assert.deepEqual(planComputerTask({ action: 'open_file', path: '\\Reports\\a.docx' }, { authorizedRoot: root }), {
    taskType: 'open_file', payload: { authorizedRoot: root, path: 'Reports\\a.docx' },
  });
});

test('planComputerTask: asks instead of guessing', () => {
  assert.match(planComputerTask({ action: 'list_files' }).reply, /حدد أولًا مجلد/);
  assert.ok(planComputerTask({ action: 'format_disk' }).reply);
  assert.ok(planComputerTask({ action: 'open_url', url: 'ftp://x' }).reply);
  assert.ok(planComputerTask({ action: 'open_file', path: 'x.exe' }, { authorizedRoot: root }).reply);
});

// ---------------------------------------------------------------- planPhoneAction

test('planPhoneAction: valid actions become device actions with a reply', () => {
  const app = planPhoneAction({ action: 'open_app', app_name: 'يوتيوب' });
  assert.deepEqual(app.action, { type: 'device_action', action: 'open_app', appName: 'يوتيوب' });
  assert.ok(app.reply);

  const alarm = planPhoneAction({ action: 'alarm', hour: 6, minute: 30, label: 'الدوام' });
  assert.equal(alarm.action.hour, 6);
  assert.match(alarm.reply, /06:30/);

  const sms = planPhoneAction({ action: 'sms', recipient: 'أمي', message: 'وصلت' });
  assert.deepEqual(sms.action, { type: 'device_action', action: 'sms', recipient: 'أمي', message: 'وصلت' });
  assert.doesNotMatch(sms.reply, /أرسلت/); // the user still presses send

  const event = planPhoneAction({ action: 'calendar_event', title: 'اجتماع', start: '2026-10-23T17:00:00+03:00' });
  assert.equal(event.action.start, '2026-10-23T14:00:00.000Z');
  assert.equal(event.action.end, '2026-10-23T15:00:00.000Z'); // one hour by default
});

test('planPhoneAction: missing or unsafe values ask instead of acting', () => {
  assert.equal(planPhoneAction({ action: 'alarm', hour: 25 }).action, undefined);
  assert.equal(planPhoneAction({ action: 'call' }).action, undefined);
  assert.equal(planPhoneAction({ action: 'open_url', url: 'intent://evil' }).action, undefined);
  assert.equal(planPhoneAction({ action: 'timer', seconds: 0 }).action, undefined);
  assert.equal(planPhoneAction({ action: 'factory_reset' }).action, undefined);
  assert.equal(planPhoneAction({ action: 'open_settings', section: 'developer' }).action.section, 'general');
});

test('planPhoneControl: needs a goal', () => {
  assert.equal(planPhoneControl({}).action, undefined);
  assert.deepEqual(planPhoneControl({ goal: 'ابحث عن وصفة كبسة', app_name: 'يوتيوب' }).action, {
    type: 'phone_agent', goal: 'ابحث عن وصفة كبسة', appName: 'يوتيوب',
  });
});

test('sanitizeCapabilities: only known flags, safe time zone', () => {
  assert.deepEqual(sanitizeCapabilities({ phoneActions: 'yes', phoneControl: true, computerRoot: root, timeZone: 'Nowhere/Zone', extra: 1 }), {
    phoneActions: false, phoneControl: true, phoneControlEnabled: false, computerRoot: root, timeZone: 'Asia/Riyadh', coords: null,
  });
  assert.deepEqual(sanitizeCapabilities({ coords: { lat: 24.71362, lon: 46.67531 } }).coords, { lat: 24.71, lon: 46.68 });
  assert.equal(sanitizeCapabilities(null).phoneActions, false);
  assert.match(nowInstruction(new Date('2026-10-22T12:00:00Z')), /2026-10-22.*15:00/);
});

test('tool schemas list every action the planners accept', () => {
  assert.deepEqual(COMPUTER_TASK_TOOL.function.parameters.properties.action.enum, COMPUTER_TASK_TYPES);
  assert.ok(PHONE_ACTION_TOOL.function.parameters.properties.action.enum.includes('calendar_event'));
});

// ---------------------------------------------------------------- phone-side helpers

test('computer tasks client: payloads match the server validation', () => {
  const cases = [
    ['list_files', { authorizedRoot: root }],
    ['search_files', { authorizedRoot: root, query: 'cv' }],
    ['transfer_file', { authorizedRoot: root, path: 'a.txt', destination: 'b.txt' }],
    ['open_file', { authorizedRoot: root, path: 'a.pdf' }],
    ['open_url', { url: 'https://smartz.example' }],
    ['open_app', { name: 'Chrome' }],
    ['run_command', { name: 'backup' }],
  ];
  for (const [type, input] of cases) assert.equal(validateComputerTask(type, buildTaskPayload(type, input)), null, type);
  assert.equal(taskNeedsRoot('open_app'), false);
  assert.equal(taskNeedsRoot('open_file'), true);
});

test('computer tasks client: readable summaries', () => {
  assert.match(describeComputerTask({ task_type: 'open_app', payload: { appName: 'الوورد' } }), /الوورد/);
  assert.match(summarizeComputerResult({ task_type: 'search_files', status: 'succeeded', result: { items: ['a.pdf', 'b.pdf'] } }), /2.*a\.pdf/);
  assert.match(
    summarizeComputerResult({ task_type: 'open_app', status: 'failed', result: { errorCode: 'APP_NOT_IN_LOCAL_LIST', available: ['المفكرة'] } }),
    /غير مضاف.*المفكرة/,
  );
  assert.match(summarizeComputerResult({ task_type: 'run_command', status: 'succeeded', result: { command: 'x', exitCode: 0, output: 'ok' } }), /بنجاح[\s\S]*ok/);
  assert.match(summarizeComputerResult({ status: 'expired' }), /انتهت/);
});

// ---------------------------------------------------------------- wiring

test('assistant route offers the new tools only when the device/account supports them', async () => {
  const route = await readFile(new URL('../app/api/assistant/route.js', import.meta.url), 'utf8');
  assert.match(route, /if \(computer\) \{ tools\.push\(COMPUTER_TASK_TOOL\)/);
  assert.match(route, /if \(capabilities\.phoneActions\)/);
  assert.match(route, /if \(capabilities\.phoneControl\)/);
  assert.match(route, /createComputerTaskForUser/);
  const flow = await readFile(new URL('../lib/audio-flow.js', import.meta.url), 'utf8');
  assert.match(flow, /capabilities: context\.capabilities/);
});

test('Windows agent: processes start only from LocalActions, never through a shell', async () => {
  const agent = await readFile(new URL('../computer-agent/AgentForm.cs', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../computer-agent/LocalActions.cs', import.meta.url), 'utf8');
  assert.doesNotMatch(agent, /Process\.Start|cmd\.exe|powershell\.exe/i);
  assert.doesNotMatch(actions, /cmd\.exe|powershell\.exe/i);
  assert.match(agent, /LocalActions\.RunCommand\(_configuration!\.CommandList/);
  assert.match(agent, /private static string ResolveSafePath/);
  assert.doesNotMatch(agent, /if \(workerCancellation\.IsCancellationRequested\)/);
});

// ---------------------------------------------------------------- self-knowledge

test('self-knowledge: covers every menu section and the new abilities', async () => {
  const { SELF_KNOWLEDGE } = await import('../lib/assistant-self-knowledge.js');
  const page = await readFile(new URL('../app/page.js', import.meta.url), 'utf8');
  const labels = [...page.matchAll(/\{ id: '[a-z-]+', label: '([^']+)' \}/g)].map((match) => match[1]);
  assert.ok(labels.length >= 13);
  for (const label of labels) assert.ok(SELF_KNOWLEDGE.includes(label.replace('ربط التطبيقات', 'ربط التطبيقات')), `missing: ${label}`);
  for (const ability of ['إجراءات الهاتف', 'التحكم في التطبيقات', 'Groq', 'على هاتفه']) assert.ok(SELF_KNOWLEDGE.includes(ability), ability);
});

test('self-knowledge: status line reflects what is connected', async () => {
  const { selfStatusInstruction } = await import('../lib/assistant-self-knowledge.js');
  const line = selfStatusInstruction({ whatsapp: true, computerLabel: 'لابتوب زياد', phoneActions: true, phoneControl: true, phoneControlEnabled: false });
  assert.match(line, /WhatsApp مربوط/);
  assert.match(line, /لابتوب زياد/);
  assert.match(line, /يحتاج تفعيلًا/);
  assert.match(selfStatusInstruction({}), /غير مربوط.*لا يوجد كمبيوتر/);
});

test('self-knowledge: added for the owner, never when replying to others on WhatsApp', async () => {
  const source = await readFile(new URL('../lib/assistant-response.js', import.meta.url), 'utf8');
  assert.match(source, /const withOwner = !String\(options\.channel \|\| ''\)\.startsWith\('whatsapp'\)/);
  assert.match(source, /withOwner \? SELF_KNOWLEDGE : ''/);
});
