import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../lib/audio-flow.js', import.meta.url), 'utf8');
const testable = source
  .replace("import { VoiceRecorder } from './voice-recorder';", 'class VoiceRecorder {}')
  .replace("import { primeSpeech, speak, stopSpeaking } from './tts';",
    `const primeSpeech = () => globalThis.__flowEvents.push('prime');
     const speak = async (text) => { globalThis.__flowEvents.push('speak:' + text); return true; };
     const stopSpeaking = () => globalThis.__flowEvents.push('stop-speaking');`)
  .replace("import { addMessage, getRecentMessages } from './conversation';",
    `const addMessage = async (role, content) => { globalThis.__flowHistory.push({ role, content }); };
     const getRecentMessages = async (limit) => globalThis.__flowHistory.slice(-limit);`);

globalThis.__flowEvents = [];
globalThis.__flowHistory = [];
const { AudioFlowManager } = await import(`data:text/javascript;base64,${Buffer.from(testable).toString('base64')}`);

function fakeRecorder({ startResult = true, startError, recording = { blob: new Blob(['x']), durationMs: 900 } } = {}) {
  return {
    state: 'idle',
    start() {
      globalThis.__flowEvents.push('mic-open');
      if (startError) return Promise.reject(startError);
      this.state = startResult ? 'recording' : 'idle';
      return Promise.resolve(startResult);
    },
    async stop() {
      globalThis.__flowEvents.push('mic-released');
      this.state = 'idle';
      return recording;
    },
    cancel() { this.state = 'idle'; },
  };
}

function setup(options = {}, responses = {}) {
  globalThis.__flowEvents = [];
  globalThis.__flowHistory = [
    { role: 'user', content: 'السلام عليكم' },
    { role: 'assistant', content: 'وعليكم السلام' },
  ];
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    const reply = responses[url] || { status: 200, body: url === '/api/transcribe' ? { text: 'كم الساعة؟' } : { reply: 'الساعة الثالثة.' } };
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  const states = [];
  const errors = [];
  const manager = new AudioFlowManager({
    recorder: fakeRecorder(options),
    getAccessToken: async () => 'token-1',
    getPreferences: () => ({ responseStyle: 'short', language: 'ar' }),
    getContext: async () => options.context || {},
    onTurnComplete: () => { globalThis.__flowEvents.push('turn-complete'); },
    onStateChange: (state) => states.push(state),
    onError: (error) => errors.push(error),
  });
  return { manager, states, errors, requests };
}

test('a full voice turn releases the mic before speaking and sends history and preferences', async () => {
  const { manager, states, errors, requests } = setup();
  assert.equal(await manager.beginTurn(), true);
  assert.deepEqual(globalThis.__flowEvents.slice(0, 3), ['stop-speaking', 'prime', 'mic-open']);
  assert.equal(manager.isRecording, true);

  assert.equal(await manager.endTurn(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(states, ['preparing', 'listening', 'transcribing', 'thinking', 'speaking', 'ready']);

  const events = globalThis.__flowEvents;
  assert.ok(events.indexOf('mic-released') < events.indexOf('speak:الساعة الثالثة.'), 'mic must be closed before speech');

  const ask = JSON.parse(requests.find((r) => r.url === '/api/assistant').init.body);
  assert.equal(ask.message, 'كم الساعة؟');
  assert.equal(ask.channel, 'voice');
  assert.equal(ask.responseStyle, 'short');
  assert.deepEqual(ask.history.map((t) => t.role), ['user', 'assistant']);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer token-1');
});

test('a recording that is too short reports TOO_SHORT and returns to ready', async () => {
  const { manager, states, errors } = setup({ recording: null });
  await manager.beginTurn();
  assert.equal(await manager.endTurn(), false);
  assert.equal(errors.at(0).code, 'TOO_SHORT');
  assert.equal(states.at(-1), 'ready');
});

test('an expired session surfaces a sign-in message, not a generic failure', async () => {
  const { manager, errors, states } = setup({}, { '/api/transcribe': { status: 401, body: {} } });
  await manager.beginTurn();
  await manager.endTurn();
  assert.equal(errors.at(0).code, 'AUTH');
  assert.equal(states.at(-1), 'error');
});

test('server error messages from transcription reach the user', async () => {
  const { manager, errors } = setup({}, { '/api/transcribe': { status: 502, body: { code: 'UPSTREAM_RATE_LIMIT', message: 'تم تجاوز حد الاستخدام' } } });
  await manager.beginTurn();
  await manager.endTurn();
  assert.equal(errors.at(0).code, 'UPSTREAM_RATE_LIMIT');
  assert.equal(errors.at(0).message, 'تم تجاوز حد الاستخدام');
});

test('a denied microphone puts the flow in error with the recorder message', async () => {
  const denied = Object.assign(new Error('لم يُسمح باستخدام الميكروفون'), { code: 'MIC_DENIED' });
  const { manager, errors, states } = setup({ startError: denied });
  assert.equal(await manager.beginTurn(), false);
  assert.equal(errors.at(0).code, 'MIC_DENIED');
  assert.equal(states.at(-1), 'error');
});

test('typed messages use the same pipeline without opening the microphone', async () => {
  const { manager, requests } = setup();
  const reply = await manager.respondTo('مرحبا');
  assert.equal(reply, 'الساعة الثالثة.');
  assert.ok(!globalThis.__flowEvents.includes('mic-open'));
  assert.equal(JSON.parse(requests[0].init.body).channel, 'text');
});

test('learning context is sent with the request and learning is triggered after the reply', async () => {
  const { manager, requests } = setup({ context: { profile: { name: 'فهد' }, memories: ['يحب القهوة'] } });
  await manager.respondTo('مرحبا');
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body.profile, { name: 'فهد' });
  assert.deepEqual(body.memories, ['يحب القهوة']);
  assert.ok(globalThis.__flowEvents.includes('turn-complete'));
});
