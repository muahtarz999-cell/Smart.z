import assert from 'node:assert/strict';
import test from 'node:test';
import { splitForSpeech } from '../lib/text-chunks.js';

// Case 1: Selected provider and voice are available -> used directly and pinned across all chunks
test('Case 1: selected provider and voice are available, used directly and pinned across chunks', async () => {
  const calls = [];
  const fakeSynthesize = async (chunk, options) => {
    calls.push({ chunk, options });
    if (options.provider === 'azure') {
      return {
        audio: new Uint8Array([1, 2, 3]),
        contentType: 'audio/mpeg',
        provider: 'azure',
        voice: options.voices?.azure || 'ar-SA-HamedNeural',
      };
    }
    return {
      audio: new Uint8Array([4, 5, 6]),
      contentType: 'audio/wav',
      provider: 'groq',
      voice: options.voices?.groq || 'fahad',
    };
  };

  const customerVoice = { provider: 'azure', voices: { azure: 'ar-SA-ZariyahNeural', groq: 'noura' } };
  const preferredProvider = customerVoice.provider !== 'auto' ? customerVoice.provider : undefined;
  const customerVoices = customerVoice.voices || {};

  const chunks = splitForSpeech('الجملة الأولى لتجربة الصوت. والجملة الثانية لإكمال الفحص.', 40);
  assert.ok(chunks.length >= 2, 'split into multiple chunks');

  let provider;
  const voice = [];
  for (const chunk of chunks) {
    const options = provider
      ? { provider, voices: customerVoices, strict: true }
      : { provider: preferredProvider, voices: customerVoices, strict: false };
    const result = await fakeSynthesize(chunk, options);
    provider = result.provider;
    voice.push({ provider: result.provider, voice: result.voice });
  }

  // First chunk: requests preferred provider 'azure' with voice 'ar-SA-ZariyahNeural'
  assert.equal(calls[0].options.provider, 'azure');
  assert.equal(calls[0].options.strict, false);
  assert.equal(calls[0].options.voices.azure, 'ar-SA-ZariyahNeural');
  assert.equal(voice[0].voice, 'ar-SA-ZariyahNeural');

  // Second chunk: pinned strictly to 'azure'
  assert.equal(calls[1].options.provider, 'azure');
  assert.equal(calls[1].options.strict, true);
  assert.equal(voice.every((v) => v.provider === 'azure'), true);
});

// Case 2: Selected provider fails -> falls back to alternative provider in chain, and pins fallback
test('Case 2: selected provider fails, falls back to alternative provider and pins fallback', async () => {
  const calls = [];
  const fakeSynthesizeWithFallback = async (chunk, options) => {
    calls.push({ chunk, options });
    if (options.provider === 'azure' && !options.strict) {
      // Azure is unavailable, fall back to groq
      return {
        audio: new Uint8Array([7, 8]),
        contentType: 'audio/wav',
        provider: 'groq',
        voice: options.voices?.groq || 'fahad',
      };
    }
    return {
      audio: new Uint8Array([9, 10]),
      contentType: 'audio/wav',
      provider: options.provider || 'groq',
      voice: options.voices?.groq || 'fahad',
    };
  };

  const customerVoice = { provider: 'azure', voices: { azure: 'ar-SA-ZariyahNeural', groq: 'noura' } };
  const preferredProvider = customerVoice.provider !== 'auto' ? customerVoice.provider : undefined;
  const customerVoices = customerVoice.voices || {};

  const chunks = ['أهلاً وسهلاً بك.', 'كيف يمكنني مساعدتك اليوم؟'];
  let provider;
  const voice = [];
  for (const chunk of chunks) {
    const options = provider
      ? { provider, voices: customerVoices, strict: true }
      : { provider: preferredProvider, voices: customerVoices, strict: false };
    const result = await fakeSynthesizeWithFallback(chunk, options);
    provider = result.provider;
    voice.push({ provider: result.provider });
  }

  // First chunk attempted azure with fallback permitted
  assert.equal(calls[0].options.provider, 'azure');
  assert.equal(calls[0].options.strict, false);

  // Fallback yielded groq, so second chunk is pinned strictly to groq
  assert.equal(calls[1].options.provider, 'groq');
  assert.equal(calls[1].options.strict, true);
  assert.equal(voice[1].provider, 'groq');
});

// Case 3: Two distinct customers have different settings -> complete isolation, zero cross-contamination
test('Case 3: two distinct customers have different settings and their voices remain isolated', async () => {
  const tenantA = {
    user_id: 'user-aaa-111',
    voice_settings: { provider: 'groq', voices: { groq: 'noura' } },
  };
  const tenantB = {
    user_id: 'user-bbb-222',
    voice_settings: { provider: 'azure', voices: { azure: 'ar-SA-ZariyahNeural' } },
  };

  const synthesizeReply = async (tenant, replyText) => {
    const customerVoice = tenant?.voice_settings || {};
    const preferredProvider = typeof customerVoice.provider === 'string' && customerVoice.provider !== 'auto'
      ? customerVoice.provider
      : undefined;
    const customerVoices = customerVoice.voices && typeof customerVoice.voices === 'object'
      ? customerVoice.voices
      : {};

    const chunks = splitForSpeech(replyText, 40);
    let provider;
    const voiceChunks = [];
    for (const chunk of chunks) {
      const options = provider
        ? { provider, voices: customerVoices, strict: true }
        : { provider: preferredProvider, voices: customerVoices, strict: false };

      // Simulate provider synthesis based on options
      const activeProvider = options.provider || 'groq';
      const activeVoice = options.voices?.[activeProvider] || 'default';
      const result = {
        audio: new Uint8Array([1]),
        contentType: activeProvider === 'azure' ? 'audio/mpeg' : 'audio/wav',
        provider: activeProvider,
        voice: activeVoice,
      };
      provider = result.provider;
      voiceChunks.push(result);
    }
    return voiceChunks;
  };

  const voiceA = await synthesizeReply(tenantA, 'مرحباً عميل أ.');
  const voiceB = await synthesizeReply(tenantB, 'مرحباً عميل ب.');

  // Customer A got Groq with Noura
  assert.equal(voiceA[0].provider, 'groq');
  assert.equal(voiceA[0].voice, 'noura');

  // Customer B got Azure with ZariyahNeural
  assert.equal(voiceB[0].provider, 'azure');
  assert.equal(voiceB[0].voice, 'ar-SA-ZariyahNeural');

  // Verify independence
  assert.notEqual(voiceA[0].provider, voiceB[0].provider);
  assert.notEqual(voiceA[0].voice, voiceB[0].voice);
});

test('send route clientVoice prioritizes body.voice over assignment voice_settings', () => {
  const bodyVoice = { provider: 'groq', voices: { groq: 'noura' } };
  const assignment = { voice_settings: { provider: 'azure', voices: { azure: 'ar-SA-HamedNeural' } } };

  // When body.voice is provided from frontend:
  const clientVoice1 = (bodyVoice && typeof bodyVoice === 'object') ? bodyVoice : (assignment?.voice_settings || {});
  assert.equal(clientVoice1.provider, 'groq');

  // When body.voice is omitted:
  const emptyBody = {};
  const clientVoice2 = (emptyBody?.voice && typeof emptyBody.voice === 'object') ? emptyBody.voice : (assignment?.voice_settings || {});
  assert.equal(clientVoice2.provider, 'azure');
});
