import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const source = await readFile(new URL('../lib/tts.js', import.meta.url), 'utf8');
const testableSource = source.replace(
  "import { Capacitor } from '@capacitor/core';",
  "const Capacitor = { isNativePlatform: () => false, isPluginAvailable: () => false, getPlatform: () => 'web' };"
);
const tts = await import(`data:text/javascript;base64,${Buffer.from(testableSource).toString('base64')}`);

function createVoice(lang, options = {}) {
  return {
    lang,
    name: options.name || lang,
    voiceURI: options.name || lang,
    ...options,
  };
}

function setupSpeechSynthesis(voices, speak) {
  const synthesis = new EventTarget();
  synthesis.voices = voices;
  synthesis.getVoices = () => synthesis.voices;
  synthesis.speak = speak || (() => {});
  synthesis.cancel = () => {};
  globalThis.window = {
    speechSynthesis: synthesis,
    SpeechSynthesisUtterance: class {
      constructor(text) {
        this.text = text;
      }
    },
  };
  return synthesis;
}

test('prefers Saudi then Gulf Arabic, accepts unspecified localService, and excludes Jordanian Arabic', async () => {
  setupSpeechSynthesis([
    createVoice('ar-JO'),
    createVoice('ar-EG', { localService: undefined }),
    createVoice('ar-AE', { localService: false }),
    createVoice('ar-SA', { localService: undefined }),
  ]);
  assert.equal((await tts.getArabicVoiceInfo()).language, 'ar-SA');

  setupSpeechSynthesis([
    createVoice('ar_JO'),
    createVoice('ar-EG'),
    createVoice('ar-KW', { localService: false }),
  ]);
  assert.equal((await tts.getArabicVoiceInfo()).language, 'ar-KW');

  const jordanOnly = setupSpeechSynthesis([createVoice('ar-JO')]);
  const jordanOnlyInfo = tts.getArabicVoiceInfo();
  jordanOnly.dispatchEvent(new Event('voiceschanged'));
  await assert.rejects(jordanOnlyInfo, /لم يعثر محرك النطق على صوت عربي/);
});

test('waits for voiceschanged and rereads voices when the initial list has no Arabic voice', async () => {
  const synthesis = setupSpeechSynthesis([createVoice('en-US')]);
  const infoPromise = tts.getArabicVoiceInfo();
  await delay(10);
  synthesis.voices = [createVoice('ar-SA', { localService: true })];
  synthesis.dispatchEvent(new Event('voiceschanged'));
  assert.equal((await infoPromise).language, 'ar-SA');
});

test('rereads the voice list after the bounded wait even if voiceschanged never fires', async () => {
  const synthesis = setupSpeechSynthesis([createVoice('en-US')]);
  const startedAt = Date.now();
  const infoPromise = tts.getArabicVoiceInfo();
  await delay(10);
  synthesis.voices = [createVoice('ar-SA', { localService: true })];
  assert.equal((await infoPromise).language, 'ar-SA');
  assert.ok(Date.now() - startedAt >= 1900);
});

test('plays speech chunks sequentially and reports synthesis errors', async () => {
  let activeUtterances = 0;
  let maxActiveUtterances = 0;
  const synthesis = setupSpeechSynthesis(
    [createVoice('ar-SA', { localService: undefined })],
    (utterance) => {
      activeUtterances += 1;
      maxActiveUtterances = Math.max(maxActiveUtterances, activeUtterances);
      setTimeout(() => {
        activeUtterances -= 1;
        utterance.onend();
      }, 0);
    }
  );

  assert.equal(await tts.speak('أ'.repeat(250)), true);
  assert.equal(maxActiveUtterances, 1);

  synthesis.speak = (utterance) => {
    setTimeout(() => utterance.onerror({ error: 'synthesis-failed' }), 0);
  };
  await assert.rejects(tts.speak('اختبار'), /synthesis-failed/);
});

test('uses native Android TTS voices and reports native engine failures', async () => {
  let activeUtterances = 0;
  let maxActiveUtterances = 0;
  let installOpened = false;
  const nativePlugin = {
    async getSupportedVoices() {
      return {
        voices: [
          createVoice('ar-JO', { localService: true }),
          createVoice('ar-EG', { localService: true }),
          createVoice('ar-SA', { localService: true }),
        ],
      };
    },
    async speak(options) {
      activeUtterances += 1;
      maxActiveUtterances = Math.max(maxActiveUtterances, activeUtterances);
      assert.equal(options.lang, 'ar-SA');
      assert.equal(options.voice, 2);
      await delay(5);
      activeUtterances -= 1;
    },
    async stop() {},
    async openInstall() {
      installOpened = true;
    },
  };
  globalThis.__nativeSpeechMock = nativePlugin;
  const nativeSource = source
    .replace(
      "import { Capacitor } from '@capacitor/core';",
      "const Capacitor = { isNativePlatform: () => true, isPluginAvailable: () => true, getPlatform: () => 'android' };"
    )
    .replace(
      "await import('@capacitor-community/text-to-speech')",
      'await Promise.resolve({ TextToSpeech: globalThis.__nativeSpeechMock })'
    );
  const nativeTts = await import(`data:text/javascript;base64,${Buffer.from(nativeSource).toString('base64')}`);

  assert.equal(nativeTts.isSpeechSupported(), true);
  assert.deepEqual(await nativeTts.getArabicVoiceInfo(), {
    name: 'ar-SA',
    language: 'ar-SA',
    localService: true,
    native: true,
  });
  assert.equal(await nativeTts.speak('أ'.repeat(250)), true);
  assert.equal(maxActiveUtterances, 1);

  nativePlugin.speak = async () => {
    throw new Error('native-engine-failed');
  };
  await assert.rejects(nativeTts.speak('اختبار'), /native-engine-failed/);

  await nativeTts.openSpeechEngineSettings();
  assert.equal(installOpened, true);
  delete globalThis.__nativeSpeechMock;
});
