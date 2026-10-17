import assert from 'node:assert/strict';
import test from 'node:test';
import { findGeminiAudio, getProviderOrder, listAvailableProviders, synthesizeWithFallback } from '../lib/cloud-tts.js';

function env(values) {
  for (const key of ['GROQ_API_KEY', 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION', 'GOOGLE_TTS_API_KEY', 'GEMINI_API_KEY', 'TTS_PROVIDER_ORDER', 'GROQ_TTS_DISABLED']) delete process.env[key];
  Object.assign(process.env, values);
}

const audioResponse = (type = 'audio/wav') => ({
  ok: true, status: 200, headers: new Headers({ 'content-type': type }), arrayBuffer: async () => new Uint8Array(200).buffer,
});

test('only configured providers are offered, in the configured order', () => {
  env({ GROQ_API_KEY: 'g', GOOGLE_TTS_API_KEY: 'k', TTS_PROVIDER_ORDER: 'google,groq,azure' });
  assert.deepEqual(getProviderOrder(), ['google', 'groq']);
  assert.equal(listAvailableProviders()[1].defaultVoice, 'fahad');
});

test('Groq Saudi voice is tried first and receives model, voice and wav format', async () => {
  env({ GROQ_API_KEY: 'g' });
  let body;
  globalThis.fetch = async (url, init) => { body = JSON.parse(init.body); return audioResponse(); };
  const result = await synthesizeWithFallback('هلا والله', { voices: { groq: 'noura' } });
  assert.equal(result.provider, 'groq');
  assert.equal(body.model, 'canopylabs/orpheus-arabic-saudi');
  assert.equal(body.voice, 'noura');
  assert.equal(body.response_format, 'wav');
});

test('a rate-limited provider falls through to the next one; unknown voices use the default', async () => {
  env({ GROQ_API_KEY: 'g', AZURE_SPEECH_KEY: 'a', AZURE_SPEECH_REGION: 'uaenorth' });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('groq')) return { ok: false, status: 429, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    assert.match(init.body, /ar-SA-HamedNeural/);
    assert.match(init.body, /&lt;b&gt;/, 'SSML must be escaped');
    return audioResponse('audio/mpeg');
  };
  const result = await synthesizeWithFallback('<b>مرحبا</b>', { voices: { azure: 'not-a-voice' } });
  assert.equal(result.provider, 'azure');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /uaenorth\.tts\.speech\.microsoft\.com/);
});

test('text longer than 200 characters skips Groq instead of failing', async () => {
  env({ GROQ_API_KEY: 'g', GOOGLE_TTS_API_KEY: 'k' });
  globalThis.fetch = async (url) => {
    assert.match(String(url), /texttospeech/);
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ audioContent: Buffer.from('x'.repeat(100)).toString('base64') }) };
  };
  const result = await synthesizeWithFallback('ا'.repeat(250));
  assert.equal(result.provider, 'google');
  assert.equal(result.contentType, 'audio/mpeg');
});

test('a preferred provider goes first; when all fail the error lists each failure', async () => {
  env({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'm' });
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: false, status: 500, headers: new Headers() }; };
  await assert.rejects(synthesizeWithFallback('مرحبا', { provider: 'gemini' }), (error) => {
    assert.equal(error.code, 'ALL_FAILED');
    assert.deepEqual(error.failures, ['gemini:UPSTREAM', 'groq:UPSTREAM']);
    return true;
  });
  assert.match(calls[0], /generativelanguage/);
});

test('no configured provider is reported distinctly', async () => {
  env({});
  await assert.rejects(synthesizeWithFallback('مرحبا'), (error) => error.code === 'NO_PROVIDERS');
});

test('Gemini audio is found in the interactions shape and the legacy shape', () => {
  assert.equal(findGeminiAudio({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'x' }, { type: 'audio', data: 'QUJD' }] }] }), 'QUJD');
  assert.equal(findGeminiAudio({ output_audio: { data: 'WFla' } }), 'WFla');
  assert.equal(findGeminiAudio({ candidates: [{ content: { parts: [{ inlineData: { data: 'TU5P' } }] } }] }), 'TU5P');
  assert.equal(findGeminiAudio({}), null);
});

test('strict keeps the chosen voice: no other provider is tried, so the voice never changes', async () => {
  env({ GOOGLE_TTS_API_KEY: 'k', AZURE_SPEECH_KEY: 'a', AZURE_SPEECH_REGION: 'uaenorth', TTS_PROVIDER_ORDER: 'azure,google' });
  const hosts = [];
  globalThis.fetch = async (url) => {
    hosts.push(new URL(url).hostname);
    if (String(url).includes('microsoft')) return { ok: false, status: 429, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, json: async () => ({ audioContent: btoa('x'.repeat(100)) }) };
  };
  await assert.rejects(synthesizeWithFallback('مرحبا', { provider: 'azure', strict: true }), (error) => {
    assert.deepEqual(error.failures, ['azure:RATE_LIMITED']);
    return true;
  });
  assert.ok(hosts.every((host) => host.includes('microsoft')), 'only the chosen voice was asked');
  // Without strict the chain carries on to the next voice, as before.
  const result = await synthesizeWithFallback('مرحبا', { provider: 'azure' });
  assert.equal(result.provider, 'google');
});
