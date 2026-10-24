import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  buildStepPrompt,
  looksLikeCardNumber,
  MAX_AGENT_STEPS,
  sanitizeHistory,
  sanitizeScreen,
  validateStepAction,
} from '../lib/phone-agent-step.js';

const screen = sanitizeScreen({
  package: 'com.google.android.youtube',
  nodes: [
    { i: 0, t: 'بحث', c: 1 },
    { i: 1, t: '', d: 'Search YouTube', e: 1 },
    { i: 2, t: '••••', p: 1, e: 1 },
    { i: 3, t: 'قائمة', s: 1 },
    { i: 'x', t: 'bad id' },
  ],
});

test('sanitizeScreen keeps well-formed nodes only and caps text', () => {
  assert.equal(screen.nodes.length, 4);
  assert.equal(screen.nodes[2].p, true);
  const long = sanitizeScreen({ nodes: [{ i: 0, t: 'x'.repeat(500) }] });
  assert.equal(long.nodes[0].t.length, 100);
  assert.equal(sanitizeScreen({ nodes: Array.from({ length: 400 }, (_, i) => ({ i, t: 'a' })) }).nodes.length, 150);
});

test('validateStepAction: taps and types only on nodes that exist', () => {
  assert.deepEqual(validateStepAction({ action: 'tap', node: 0, say: 'أضغط بحث' }, screen), { action: 'tap', node: 0, say: 'أضغط بحث' });
  assert.equal(validateStepAction({ action: 'tap', node: 99, say: '' }, screen).action, 'wait');
  assert.deepEqual(
    validateStepAction({ action: 'type', node: 1, text: 'كبسة', submit: true, say: '' }, screen),
    { action: 'type', node: 1, text: 'كبسة', submit: true, say: '' },
  );
});

test('validateStepAction: never types into password fields or card numbers', () => {
  assert.equal(validateStepAction({ action: 'type', node: 2, text: 'secret', say: '' }, screen).action, 'need_user');
  assert.equal(validateStepAction({ action: 'type', node: 1, text: '4111 1111 1111 1111', say: '' }, screen).action, 'need_user');
  assert.equal(validateStepAction({ action: 'type', node: 1, text: 'اتصل على 966501234567', say: '' }, screen).action, 'type');
});

test('validateStepAction: unknown actions stop and hand back to the user', () => {
  assert.equal(validateStepAction({ action: 'pay_now', say: '' }, screen).action, 'need_user');
  assert.equal(validateStepAction(null, screen).action, 'need_user');
  assert.equal(validateStepAction({ action: 'open_app', say: '' }, screen).action, 'need_user');
  assert.equal(validateStepAction({ action: 'scroll', direction: 'sideways', say: '' }, screen).direction, 'down');
});

test('looksLikeCardNumber uses the Luhn check', () => {
  assert.equal(looksLikeCardNumber('4111-1111-1111-1111'), true);
  assert.equal(looksLikeCardNumber('966501234567'), false);
  assert.equal(looksLikeCardNumber('hello'), false);
});

test('buildStepPrompt shows the goal, the screen and the history', () => {
  const prompt = buildStepPrompt({
    goal: 'ابحث عن وصفة كبسة',
    appName: 'يوتيوب',
    screen,
    history: sanitizeHistory([{ action: 'tap', node: 0, ok: true, say: 'ضغطت بحث' }, { action: 'evil' }]),
    step: 2,
  });
  assert.match(prompt, /ابحث عن وصفة كبسة/);
  assert.match(prompt, /\[0\] «بحث» \{يُضغط\}/);
  assert.match(prompt, /\[2\].*كلمة مرور/);
  assert.doesNotMatch(prompt, /••••/); // password content is never sent to the model
  assert.match(prompt, /الخطوة رقم 3/);
  assert.match(prompt, /2\. wait/);
});

test('step route enforces the step limit and the auth check', async () => {
  const route = await readFile(new URL('../app/api/phone-agent/step/route.js', import.meta.url), 'utf8');
  assert.match(route, /requireCustomerRegistered/);
  assert.match(route, /step >= MAX_AGENT_STEPS/);
  assert.match(route, /validateStepAction\(args, screen\)/);
  assert.equal(MAX_AGENT_STEPS, 25);
});

test('Android: accessibility service is declared, private, and the plugins are registered', async () => {
  const base = '../android/app/src/main/';
  const manifest = await readFile(new URL(`${base}AndroidManifest.xml`, import.meta.url), 'utf8');
  const main = await readFile(new URL(`${base}java/com/smartz/assistant/MainActivity.java`, import.meta.url), 'utf8');
  const agent = await readFile(new URL(`${base}java/com/smartz/assistant/screen/ScreenAgent.java`, import.meta.url), 'utf8');
  assert.match(manifest, /android:name="\.screen\.SmartzAccessibilityService"[\s\S]*?android:permission="android\.permission\.BIND_ACCESSIBILITY_SERVICE"/);
  assert.match(manifest, /com\.android\.alarm\.permission\.SET_ALARM/);
  assert.match(manifest, /android\.intent\.category\.LAUNCHER/);
  assert.match(main, /registerPlugin\(SystemActionsPlugin\.class\)/);
  assert.match(main, /registerPlugin\(ScreenControlPlugin\.class\)/);
  assert.match(agent, /MAX_STEPS = 25/);
  assert.match(agent, /node\.isPassword\(\)/);
  assert.match(agent, /"إيقاف"/);
});
