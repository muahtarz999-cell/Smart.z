import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (await readFile(new URL('../lib/speech.js', import.meta.url), 'utf8'))
  .replace(/import \{[\s\S]*?\} from '\.\/tts';/,
    `const cleanTextForSpeech = (t) => String(t).trim();
     const primeDeviceSpeech = () => {};
     const speakOnDevice = async (t) => { globalThis.__deviceSpoken.push(t); return true; };
     const stopDeviceSpeech = () => {};`)
  .replace('const TEST_VOICE_TIMEOUT_MS = 15000;', 'const TEST_VOICE_TIMEOUT_MS = 25;')
  .replace("from './text-chunks';", `from '${new URL('../lib/text-chunks.js', import.meta.url).href}';`);
const speech = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

class FakeAudio {
  setAttribute() {}
  play() { globalThis.__played.push(this.src); setTimeout(() => this.onended?.(), 0); return Promise.resolve(); }
  pause() {}
}

function setup({ cloud = 'ok', deviceFallback = true } = {}) {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  globalThis.window = {};
  globalThis.Audio = FakeAudio;
  globalThis.URL.createObjectURL = () => `blob:${Math.random()}`;
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.__played = [];
  globalThis.__deviceSpoken = [];
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const fail = cloud === 'fail' || (cloud === 'fail-second' && requests.length === 2) || (cloud === 'fail-after-first' && requests.length > 1);
    if (fail) return { ok: false, status: 502, json: async () => ({ code: 'CLOUD_TTS_FAILED', message: 'تعذر' }) };
    return { ok: true, status: 200, headers: new Headers({ 'X-TTS-Provider': 'groq' }), blob: async () => new Blob(['a']) };
  };
  speech.configureSpeech({ getAccessToken: async () => 't' });
  speech.saveVoiceSettings({ deviceFallback, provider: 'auto', voices: { groq: 'noura' } });
  return requests;
}

test('splitForCloud keeps sentences together and never exceeds 180 characters', () => {
  const text = 'جملة أولى قصيرة. ' + 'كلمة '.repeat(60) + '؟ وجملة أخيرة!';
  const chunks = speech.splitForCloud(text);
  assert.ok(chunks.every((c) => c.length <= 180));
  assert.equal(chunks[0], 'جملة أولى قصيرة.');
  assert.ok(chunks.at(-1).endsWith('وجملة أخيرة!'));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' ').trim(), 'no text is lost');
});

test('cloud voice speaks every chunk in order and sends the chosen voice', async () => {
  const requests = setup();
  const text = 'السلام عليكم. ' + 'هذا رد طويل '.repeat(20);
  assert.equal(await speech.speak(text), true);
  assert.equal(requests.length, speech.splitForCloud(text).length);
  assert.ok(requests.length > 1);
  assert.deepEqual(requests[0].voices, { groq: 'noura' });
  assert.equal(requests[0].provider, undefined, 'auto sends no provider');
  assert.equal(globalThis.__played.length, requests.length);
  assert.equal(speech.getLastSpeechInfo().engine, 'cloud');
  assert.equal(globalThis.__deviceSpoken.length, 0);
});

test('a reply keeps one voice: later chunks ask for the first chunk\'s voice only, and any cloud voice rescues a miss', async () => {
  const requests = setup({ cloud: 'fail-second' });
  const text = 'الجزء الأول من الرد. ' + 'والجزء الثاني الطويل '.repeat(12);
  assert.equal(await speech.speak(text), true);
  assert.equal(requests[1].provider, 'groq', 'the second chunk asks for the voice of the first');
  assert.equal(requests[1].strict, true, 'and only that voice');
  assert.equal(requests[2].strict, undefined, 'its miss is retried with any cloud voice');
  assert.equal(globalThis.__deviceSpoken.length, 0, 'the device voice is not needed');
  assert.equal(speech.getLastSpeechInfo().engine, 'cloud');
});

test('when the cloud fails mid-reply, the device voice speaks only the rest', async () => {
  setup({ cloud: 'fail-after-first' });
  const text = 'الجزء الأول من الرد. ' + 'والجزء الثاني الطويل '.repeat(12);
  assert.equal(await speech.speak(text), true);
  assert.equal(globalThis.__played.length, 1);
  assert.equal(globalThis.__deviceSpoken.length, 1);
  assert.doesNotMatch(globalThis.__deviceSpoken[0], /الجزء الأول/);
  assert.equal(speech.getLastSpeechInfo().engine, 'device');
});

test('with the device voice turned off, a cloud failure is reported and nothing else speaks', async () => {
  setup({ cloud: 'fail', deviceFallback: false });
  await assert.rejects(speech.speak('مرحبا'), /صوت الجهاز معطّل/);
  assert.equal(globalThis.__deviceSpoken.length, 0);
});

test('voice setup test times out when speech initialization never settles', async () => {
  setup();
  speech.configureSpeech({ getAccessToken: () => new Promise(() => {}) });
  const result = await speech.testVoice('اختبار');
  assert.equal(result.success, false);
  assert.match(result.error, /انتهت مهلة اختبار صوت المساعد/);
});

test('settings persist and default to cloud-first with device fallback on', () => {
  setup();
  globalThis.localStorage.setItem('smartz-voice-v1', '{}');
  assert.deepEqual(speech.getVoiceSettings(), { provider: 'auto', voices: {}, deviceFallback: true });
  speech.saveVoiceSettings({ provider: 'azure' });
  assert.equal(speech.getVoiceSettings().provider, 'azure');
});
