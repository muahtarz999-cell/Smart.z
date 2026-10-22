import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { brainAttempts, brainOrder, brainStatus, omnirouteEndpoint } from '../lib/brain-providers.js';
import { generateAssistantReply } from '../lib/assistant-response.js';

const BRAIN_ENV = ['GROQ_API_KEY', 'GROQ_API_KEY_2', 'GROQ_MODEL', 'CEREBRAS_API_KEY', 'CEREBRAS_MODEL', 'OMNIROUTE_URL', 'OMNIROUTE_API_KEY',
  'OMNIROUTE_MODEL', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_BACKUP', 'OPENROUTER_MODEL', 'BRAIN_PROVIDER_ORDER'];
function resetEnv(values = {}) {
  for (const name of BRAIN_ENV) delete process.env[name];
  Object.assign(process.env, values);
}

test('brain: default order groq → cerebras → omniroute → openrouter; unknown names ignored', () => {
  assert.deepEqual(brainOrder({}), ['groq', 'cerebras', 'omniroute', 'openrouter']);
  assert.deepEqual(brainOrder({ BRAIN_PROVIDER_ORDER: 'cerebras, groq, evil' }), ['cerebras', 'groq']);
  assert.deepEqual(brainOrder({ BRAIN_PROVIDER_ORDER: 'nothing' }), ['groq', 'cerebras', 'omniroute', 'openrouter']);
});

test('brain: only configured providers become attempts, with their own models and timeouts', () => {
  resetEnv({
    CEREBRAS_API_KEY: 'c1',
    CEREBRAS_MODEL: 'zai-glm-4.7',
    OMNIROUTE_URL: 'https://omni.example.com/v1/',
    OMNIROUTE_API_KEY: 'o1',
    OPENROUTER_API_KEY: 'r1',
  });
  const attempts = brainAttempts(10_000, 7_000);
  assert.deepEqual(attempts.map((a) => [a.provider, a.model, a.timeoutMs]), [
    ['cerebras', 'zai-glm-4.7', 10_000],
    ['omniroute', 'auto', 7_000],
    ['openrouter', 'openai/gpt-oss-120b', 7_000],
  ]);
  assert.equal(attempts[1].endpoint, 'https://omni.example.com/v1/chat/completions');
  assert.equal(attempts.find((a) => a.provider === 'openrouter').search, 'online');
  assert.deepEqual(brainStatus().map((p) => [p.name, p.configured]), [['groq', false], ['cerebras', true], ['omniroute', true], ['openrouter', true]]);
  resetEnv();
});

test('brain: OmniRoute must be https (http only on a local/private host)', () => {
  assert.equal(omnirouteEndpoint('http://omni.example.com'), null);
  assert.equal(omnirouteEndpoint('http://localhost:20128'), 'http://localhost:20128/v1/chat/completions');
  assert.equal(omnirouteEndpoint('not a url'), null);
  assert.equal(omnirouteEndpoint(''), null);
});

test('brain: falls through Groq → Cerebras → OmniRoute → OpenRouter until one answers', async () => {
  resetEnv({ GROQ_API_KEY: 'g', CEREBRAS_API_KEY: 'c', OMNIROUTE_URL: 'https://omni.example.com', OPENROUTER_API_KEY: 'r' });
  const visited = [];
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname;
    visited.push(host);
    if (host === 'omni.example.com') return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'من OmniRoute' } }] }) };
    return { ok: false, status: 503, json: async () => ({}) };
  };
  assert.equal(await generateAssistantReply('مرحبا'), 'من OmniRoute');
  assert.deepEqual(visited, ['api.groq.com', 'api.cerebras.ai', 'omni.example.com']);
  resetEnv();
});

test('brain: a rate-limited key tries the next key of the same provider; a down provider is skipped', async () => {
  resetEnv({ GROQ_API_KEY: 'g1', GROQ_API_KEY_2: 'g2', CEREBRAS_API_KEY: 'c' });
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(`${new URL(url).hostname}:${init.headers.Authorization.slice(7)}`);
    if (url.includes('cerebras')) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    return { ok: false, status: 429, json: async () => ({}) };
  };
  assert.equal(await generateAssistantReply('مرحبا'), 'ok');
  assert.ok(seen.filter((entry) => entry.startsWith('api.groq.com')).length >= 1);
  assert.equal(seen.at(-1), 'api.cerebras.ai:c');
  resetEnv();
});

test('brain: the voice keeps its own chain (not touched by the brain providers)', async () => {
  const tts = await readFile(new URL('../lib/cloud-tts.js', import.meta.url), 'utf8');
  const transcription = await readFile(new URL('../lib/transcription.js', import.meta.url), 'utf8');
  assert.doesNotMatch(tts, /brain-providers/);
  assert.doesNotMatch(transcription, /brain-providers/);
  const response = await readFile(new URL('../lib/assistant-response.js', import.meta.url), 'utf8');
  assert.match(response, /import \{ brainAttempts \} from '\.\/brain-providers\.js'/);
  assert.doesNotMatch(response, /const GROQ_MODEL =/);
});
