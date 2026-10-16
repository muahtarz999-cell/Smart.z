import assert from 'node:assert/strict';
import test from 'node:test';
import { getGroqKeys, groqKeysInOrder, reportGroqFailure, resetGroqKeyState } from '../lib/groq-keys.js';
import { generateAssistantReply } from '../lib/assistant-response.js';
import { synthesizeWithFallback } from '../lib/cloud-tts.js';

const NAMES = ['GROQ_API_KEY', 'GROQ_API_KEY_1', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3', 'GROQ_API_KEY_4', 'GROQ_API_KEY_5',
  'OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_BACKUP', 'TTS_PROVIDER_ORDER', 'GROQ_TTS_DISABLED',
  'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION', 'GOOGLE_TTS_API_KEY', 'GEMINI_API_KEY'];

function env(values) {
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, values);
  resetGroqKeyState();
}

const authOf = (init) => init.headers.Authorization.replace('Bearer ', '');

test('collects up to five distinct Groq keys', () => {
  env({ GROQ_API_KEY: 'a', GROQ_API_KEY_2: 'b', GROQ_API_KEY_3: ' a ', GROQ_API_KEY_5: 'c' });
  assert.deepEqual(getGroqKeys(), ['a', 'b', 'c']);
  env({});
  assert.deepEqual(getGroqKeys(), []);
});

test('rotates the starting key and keeps resting keys last', () => {
  env({ GROQ_API_KEY: 'a', GROQ_API_KEY_2: 'b', GROQ_API_KEY_3: 'c' });
  assert.deepEqual(groqKeysInOrder(), ['a', 'b', 'c']);
  assert.deepEqual(groqKeysInOrder(), ['b', 'c', 'a']);
  reportGroqFailure('c', 429);
  assert.deepEqual(groqKeysInOrder(), ['a', 'b', 'c']);
  reportGroqFailure('a', 500); // a server error is not the key's fault
  assert.deepEqual(groqKeysInOrder(), ['a', 'b', 'c']);
});

test('a rate-limited Groq key hands the chat over to the next key', async () => {
  env({ GROQ_API_KEY: 'a', GROQ_API_KEY_2: 'b', OPENROUTER_API_KEY: 'o' });
  const used = [];
  globalThis.fetch = async (url, init) => {
    used.push(`${url.includes('groq') ? 'groq' : 'or'}:${authOf(init)}`);
    if (authOf(init) === 'a') return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'تم' } }] }) };
  };
  assert.equal(await generateAssistantReply('مرحبا'), 'تم');
  assert.deepEqual(used, ['groq:a', 'groq:b']);
});

test('a Groq timeout skips the other Groq keys and goes to OpenRouter', async () => {
  env({ GROQ_API_KEY: 'a', GROQ_API_KEY_2: 'b', OPENROUTER_API_KEY: 'o' });
  const used = [];
  globalThis.fetch = async (url, init) => {
    used.push(`${url.includes('groq') ? 'groq' : 'or'}:${authOf(init)}`);
    if (url.includes('groq')) throw new Error('TimeoutError');
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'بديل' } }] }) };
  };
  assert.equal(await generateAssistantReply('مرحبا'), 'بديل');
  assert.deepEqual(used, ['groq:a', 'or:o']);
});

test('Groq voice moves to the next account when one is rate limited', async () => {
  env({ GROQ_API_KEY: 'a', GROQ_API_KEY_2: 'b' });
  const used = [];
  globalThis.fetch = async (url, init) => {
    used.push(authOf(init));
    if (authOf(init) === 'a') return { ok: false, status: 429, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/wav' }), arrayBuffer: async () => new ArrayBuffer(512) };
  };
  const result = await synthesizeWithFallback('مرحبا');
  assert.equal(result.provider, 'groq');
  assert.deepEqual(used, ['a', 'b']);
});
