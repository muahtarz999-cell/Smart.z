import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../lib/audio-flow.js', import.meta.url), 'utf8');
const testableSource = source
  .replace(
    "import { VoiceActivityDetector } from './vad';",
    `let vadStart = async () => true;
     let vadStopCalls = 0;
     class VoiceActivityDetector {
       constructor() { this.isSpeaking = false; }
       async start() {
         const started = await vadStart();
         this.isRunning = started;
         return started;
       }
       stop() { this.isRunning = false; vadStopCalls += 1; }
       setInterruptMode() {}
     }`
  )
  .replace(
    "import { speak, stopSpeaking } from './tts';",
    'const speak = async () => true; const stopSpeaking = () => {};'
  )
  .replace(
    "import { addMessage, getRecentMessages } from './conversation';",
    'const addMessage = async () => {}; const getRecentMessages = async () => [];'
  );
const audioFlowModule = await import(
  `data:text/javascript;base64,${Buffer.from(
    `${testableSource}\nexport const testControls = { setVADStart: (start) => { vadStart = start; }, get vadStopCalls() { return vadStopCalls; } };`
  ).toString('base64')}`
);

function createManager() {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop() {} }],
        }),
      },
    },
  });
  return new audioFlowModule.AudioFlowManager();
}

test('starts and stops listening through the page-facing lifecycle methods', async () => {
  const manager = createManager();

  assert.equal(await manager.start(), true);
  assert.equal(manager.isListening, true);
  assert.equal(manager.isVADRunning, true);

  manager.stopListening();
  assert.equal(manager.isListening, false);
  assert.equal(manager.isVADRunning, false);
  assert.equal(manager.vad, null);

  await manager.start();
  manager.stop();
  assert.equal(manager.isListening, false);
  assert.equal(manager.vad, null);
});

test('cancels a microphone start when the user releases before VAD startup completes', async () => {
  const manager = createManager();
  let finishStart;
  audioFlowModule.testControls.setVADStart(
    () => new Promise((resolve) => { finishStart = resolve; })
  );

  const startPromise = manager.start();
  while (!finishStart) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  manager.stopListening();
  finishStart(true);

  assert.equal(await startPromise, false);
  assert.equal(manager.isListening, false);
  assert.equal(manager.vad, null);
  assert.ok(audioFlowModule.testControls.vadStopCalls >= 2);
});
