/**
 * Cloud text-to-speech providers (server only). Each provider turns one short
 * chunk of Arabic text into audio. A provider is active only when its keys
 * are set in the environment; the order of the fallback chain comes from
 * TTS_PROVIDER_ORDER (default: groq,azure,google,gemini).
 *
 *   groq   — Canopy Labs Orpheus, Saudi dialect. Uses the existing GROQ_API_KEY. Max 200 chars.
 *   azure  — Azure AI Speech neural voices (ar-SA, Gulf). Free tier: 0.5M chars/month.
 *   google — Google Cloud Text-to-Speech, Chirp 3 HD (ar-XA). Free tier: 1M chars/month.
 *   gemini — Gemini API TTS (Standard Arabic) with a speaking-style prompt. Free tier with rate limits.
 */

export const MAX_TTS_CHARACTERS = 600;

export const PROVIDERS = {
  groq: {
    label: 'Groq · لهجة سعودية',
    maxCharacters: 200,
    defaultVoice: 'fahad',
    voices: [
      { id: 'fahad', label: 'فهد', gender: 'male' },
      { id: 'abdullah', label: 'عبدالله', gender: 'male' },
      { id: 'sultan', label: 'سلطان', gender: 'male' },
      { id: 'noura', label: 'نورة', gender: 'female' },
      { id: 'lulwa', label: 'لولوة', gender: 'female' },
      { id: 'aisha', label: 'عائشة', gender: 'female' },
    ],
    isConfigured: () => Boolean(process.env.GROQ_API_KEY) && process.env.GROQ_TTS_DISABLED !== 'true',
    async synthesize(text, voice, signal) {
      const response = await fetch('https://api.groq.com/openai/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-arabic-saudi',
          input: text,
          voice,
          response_format: 'wav',
        }),
        signal,
      });
      return audioOrError(response, 'audio/wav');
    },
  },

  azure: {
    label: 'Azure · سعودي وخليجي',
    maxCharacters: MAX_TTS_CHARACTERS,
    defaultVoice: 'ar-SA-HamedNeural',
    voices: [
      { id: 'ar-SA-HamedNeural', label: 'حامد (سعودي)', gender: 'male' },
      { id: 'ar-SA-ZariyahNeural', label: 'زارية (سعودية)', gender: 'female' },
      { id: 'ar-KW-FahedNeural', label: 'فهد (كويتي)', gender: 'male' },
      { id: 'ar-AE-FatimaNeural', label: 'فاطمة (إماراتية)', gender: 'female' },
    ],
    isConfigured: () => Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
    async synthesize(text, voice, signal) {
      const locale = voice.split('-').slice(0, 2).join('-');
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">`
        + `<voice name="${voice}">${escapeXml(text)}</voice></speak>`;
      const response = await fetch(`https://${process.env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
          'User-Agent': 'smart-z',
        },
        body: ssml,
        signal,
      });
      return audioOrError(response, 'audio/mpeg');
    },
  },

  google: {
    label: 'Google Cloud · عربي فصيح',
    maxCharacters: MAX_TTS_CHARACTERS,
    defaultVoice: 'ar-XA-Chirp3-HD-Charon',
    voices: [
      { id: 'ar-XA-Chirp3-HD-Charon', label: 'شارون', gender: 'male' },
      { id: 'ar-XA-Chirp3-HD-Fenrir', label: 'فنرير', gender: 'male' },
      { id: 'ar-XA-Chirp3-HD-Kore', label: 'كوري', gender: 'female' },
      { id: 'ar-XA-Chirp3-HD-Aoede', label: 'أويدي', gender: 'female' },
    ],
    isConfigured: () => Boolean(process.env.GOOGLE_TTS_API_KEY),
    async synthesize(text, voice, signal) {
      const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GOOGLE_TTS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: 'ar-XA', name: voice },
          audioConfig: { audioEncoding: 'MP3' },
        }),
        signal,
      });
      if (!response.ok) return audioOrError(response);
      const data = await response.json().catch(() => null);
      if (!data?.audioContent) throw new ProviderError('EMPTY_AUDIO');
      return { audio: base64ToBytes(data.audioContent), contentType: 'audio/mpeg' };
    },
  },

  gemini: {
    label: 'Gemini · عربي بأسلوب موجّه',
    maxCharacters: MAX_TTS_CHARACTERS,
    defaultVoice: 'Charon',
    voices: [
      { id: 'Charon', label: 'شارون', gender: 'male' },
      { id: 'Puck', label: 'باك', gender: 'male' },
      { id: 'Kore', label: 'كوري', gender: 'female' },
      { id: 'Aoede', label: 'أويدي', gender: 'female' },
    ],
    isConfigured: () => Boolean(process.env.GEMINI_API_KEY),
    async synthesize(text, voice, signal) {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts',
          input: [{
            type: 'user_input',
            content: [{
              type: 'text',
              text,
              annotations: [{
                type: 'speech_metadata',
                style: process.env.GEMINI_TTS_STYLE || 'بلهجة سعودية بيضاء، بنبرة دافئة وطبيعية وسرعة متوسطة',
              }],
            }],
          }],
          response_format: { type: 'audio' },
          generation_config: { speech_config: [{ voice }] },
        }),
        signal,
      });
      if (!response.ok) return audioOrError(response);
      const data = await response.json().catch(() => null);
      const audio = findGeminiAudio(data);
      if (!audio) throw new ProviderError('EMPTY_AUDIO');
      return { audio: base64ToBytes(audio), contentType: 'audio/wav' };
    },
  },
};

export class ProviderError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function audioOrError(response, contentType) {
  if (!response.ok) {
    const code = response.status === 429 ? 'RATE_LIMITED'
      : response.status === 401 || response.status === 403 ? 'AUTH'
        : response.status === 400 ? 'BAD_REQUEST' : 'UPSTREAM';
    throw new ProviderError(code, response.status);
  }
  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.byteLength < 64) throw new ProviderError('EMPTY_AUDIO');
  return { audio, contentType: response.headers.get('content-type')?.startsWith('audio/') ? response.headers.get('content-type') : contentType };
}

function escapeXml(text) {
  return text.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Interactions API: steps[].content[] { type: 'audio', data }; also accepts output_audio and legacy generateContent shapes. */
export function findGeminiAudio(data) {
  if (!data) return null;
  if (data.output_audio?.data) return data.output_audio.data;
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const blocks = steps.flatMap((step) => (Array.isArray(step?.content) ? step.content : []))
    .filter((block) => block?.type === 'audio' && block.data);
  if (blocks.length) return blocks.at(-1).data;
  return data.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData.data || null;
}

export function getProviderOrder() {
  const configured = (process.env.TTS_PROVIDER_ORDER || 'groq,azure,google,gemini')
    .split(',').map((name) => name.trim()).filter((name) => PROVIDERS[name]);
  return configured.filter((name) => PROVIDERS[name].isConfigured());
}

export function listAvailableProviders() {
  return getProviderOrder().map((id) => ({
    id,
    label: PROVIDERS[id].label,
    defaultVoice: PROVIDERS[id].defaultVoice,
    voices: PROVIDERS[id].voices,
  }));
}

/**
 * Tries the preferred provider first, then the rest of the chain.
 * Returns { audio, contentType, provider } or throws ProviderError('ALL_FAILED').
 */
export async function synthesizeWithFallback(text, { provider, voices = {} } = {}) {
  const order = getProviderOrder();
  if (!order.length) throw new ProviderError('NO_PROVIDERS');
  const chain = provider && order.includes(provider) ? [provider, ...order.filter((p) => p !== provider)] : order;
  const failures = [];

  for (const name of chain) {
    const definition = PROVIDERS[name];
    if (text.length > definition.maxCharacters) {
      failures.push(`${name}:TOO_LONG`);
      continue;
    }
    const requested = voices[name];
    const voice = definition.voices.some((v) => v.id === requested) ? requested : definition.defaultVoice;
    try {
      const result = await definition.synthesize(text, voice, AbortSignal.timeout(12_000));
      return { ...result, provider: name, voice };
    } catch (error) {
      failures.push(`${name}:${error?.code || error?.name || 'ERROR'}`);
    }
  }
  const error = new ProviderError('ALL_FAILED');
  error.failures = failures;
  throw error;
}
