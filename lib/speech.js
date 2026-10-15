'use client';

/**
 * Speaks assistant replies. Cloud voices are preferred; the phone's own voice
 * is a fallback the user can turn off in settings.
 *
 *   1. The reply is split into sentence chunks (≤180 chars — the Groq Saudi
 *      model accepts 200 per request).
 *   2. Chunk 1 is requested from /api/speech; while it plays, chunk 2 is
 *      already being fetched, so speech starts after the first chunk only.
 *   3. If the cloud fails (no keys, rate limit, no internet) the rest of the
 *      reply is spoken by the device voice — unless the user disabled it.
 *
 * Playback uses one shared <audio> element primed inside the user's tap:
 * iOS and Android only allow later, programmatic playback on an element that
 * was started by a gesture, and <audio> keeps playing with the iPhone silent
 * switch on (Web Audio does not).
 */

import {
  cleanTextForSpeech,
  primeSpeech as primeDeviceSpeech,
  speak as speakOnDevice,
  stopSpeaking as stopDeviceSpeech,
} from './tts';

const SETTINGS_KEY = 'smartz-voice-v1';
const DEFAULT_SETTINGS = Object.freeze({ provider: 'auto', voices: {}, deviceFallback: true });
const CLOUD_CHUNK_CHARACTERS = 180;
const NO_PROVIDER_BACKOFF_MS = 10 * 60 * 1000;
// 50 ms of silence (8 kHz, 16-bit mono): enough to unlock playback on the shared element.
const SILENT_WAV = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

let getAccessToken = async () => null;
let audioElement = null;
let generation = 0;
let activePlayback = null; // { resolve, url }
let activeController = null;
let cloudUnavailableUntil = 0;
let lastSpeech = { engine: null, provider: null, error: null };

export class SpeechError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SpeechSynthesisError';
    this.code = code;
  }
}

export function configureSpeech(options = {}) {
  if (typeof options.getAccessToken === 'function') getAccessToken = options.getAccessToken;
}

export function getVoiceSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      provider: typeof stored.provider === 'string' ? stored.provider : DEFAULT_SETTINGS.provider,
      voices: stored.voices && typeof stored.voices === 'object' ? stored.voices : {},
      deviceFallback: stored.deviceFallback !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS, voices: {} };
  }
}

export function saveVoiceSettings(changes) {
  const next = { ...getVoiceSettings(), ...changes };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
  cloudUnavailableUntil = 0; // a settings change deserves a fresh attempt
  return next;
}

export function getLastSpeechInfo() {
  return { ...lastSpeech };
}

function getAudioElement() {
  if (!audioElement && typeof Audio !== 'undefined') {
    audioElement = new Audio();
    audioElement.preload = 'auto';
    audioElement.setAttribute('playsinline', '');
  }
  return audioElement;
}

/** Call synchronously inside a tap/press/submit handler. */
export function primeSpeech() {
  primeDeviceSpeech();
  try {
    if (typeof navigator !== 'undefined' && navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch {}
  const audio = getAudioElement();
  if (!audio || activePlayback) return;
  try {
    audio.src = SILENT_WAV;
    audio.play()?.catch(() => {});
  } catch {}
}

/** Sentence-aware chunks no longer than `max` characters. */
export function splitForCloud(text, max = CLOUD_CHUNK_CHARACTERS) {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?؟،؛\n]+[.!?؟،؛\n]*/g) || [];
  const chunks = [];
  let current = '';
  const push = () => { if (current.trim()) chunks.push(current.trim()); current = ''; };
  for (const sentence of sentences) {
    if (sentence.length > max) {
      push();
      let piece = '';
      for (const word of sentence.split(' ')) {
        if ((piece + ' ' + word).trim().length > max) { if (piece) chunks.push(piece.trim()); piece = word.slice(0, max); }
        else piece = `${piece} ${word}`;
      }
      if (piece.trim()) current = piece;
      continue;
    }
    if ((current + sentence).length > max) push();
    current += sentence;
  }
  push();
  return chunks;
}

async function fetchCloudChunk(text, settings, signal) {
  const token = await getAccessToken();
  if (!token) throw new SpeechError('AUTH', 'انتهت جلسة الدخول.');
  let response;
  try {
    response = await fetch('/api/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        text,
        provider: settings.provider === 'auto' ? undefined : settings.provider,
        voices: settings.voices,
      }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new SpeechError('NETWORK', 'لا يوجد اتصال للصوت السحابي.');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new SpeechError(data.code || 'CLOUD_TTS_FAILED', data.message || 'تعذر توليد الصوت السحابي.');
  }
  return { blob: await response.blob(), provider: response.headers.get('X-TTS-Provider') };
}

function playBlob(blob, gen) {
  const audio = getAudioElement();
  if (!audio) return Promise.reject(new SpeechError('NO_AUDIO', 'تشغيل الصوت غير مدعوم هنا.'));
  return new Promise((resolve, reject) => {
    if (gen !== generation) { resolve(false); return; }
    const url = URL.createObjectURL(blob);
    const cleanup = () => {
      audio.onended = null;
      audio.onerror = null;
      URL.revokeObjectURL(url);
      if (activePlayback?.url === url) activePlayback = null;
    };
    activePlayback = { url, resolve: (value) => { cleanup(); resolve(value); } };
    audio.onended = () => { cleanup(); resolve(true); };
    audio.onerror = () => { cleanup(); reject(new SpeechError('PLAYBACK', 'تعذر تشغيل الملف الصوتي.')); };
    audio.src = url;
    const started = audio.play();
    started?.catch?.((error) => {
      cleanup();
      reject(new SpeechError(
        error?.name === 'NotAllowedError' ? 'NOT_ALLOWED' : 'PLAYBACK',
        error?.name === 'NotAllowedError' ? 'منع النظام تشغيل الصوت. اضغط زر التحدث مرة أخرى.' : 'تعذر تشغيل الصوت.',
      ));
    });
  });
}

/** Plays every chunk from the cloud. On failure, rejects with error.remainingText set. */
async function speakCloud(text, settings, gen) {
  const chunks = splitForCloud(text);
  if (!chunks.length) return false;
  const controller = new AbortController();
  activeController = controller;
  const request = (index) => {
    const promise = fetchCloudChunk(chunks.at(index), settings, controller.signal);
    promise.catch(() => {}); // handled when awaited
    return promise;
  };

  let pending = request(0);
  for (let index = 0; index < chunks.length; index += 1) {
    let chunk;
    try {
      chunk = await pending;
    } catch (error) {
      if (gen !== generation) return false;
      error.remainingText = chunks.slice(index).join(' ');
      throw error;
    }
    if (gen !== generation) return false;
    pending = index + 1 < chunks.length ? request(index + 1) : null;
    lastSpeech = { engine: 'cloud', provider: chunk.provider, error: null };
    let played;
    try {
      played = await playBlob(chunk.blob, gen);
    } catch (error) {
      error.remainingText = chunks.slice(index).join(' ');
      throw error;
    }
    if (!played || gen !== generation) return false;
  }
  return true;
}

export async function speak(text) {
  if (!text || typeof window === 'undefined') return false;
  stopSpeaking();
  const gen = ++generation;
  const settings = getVoiceSettings();
  const spoken = cleanTextForSpeech(text);
  if (!spoken) return false;

  let remaining = text;
  let cloudError = null;
  if (Date.now() >= cloudUnavailableUntil) {
    try {
      return await speakCloud(spoken, settings, gen);
    } catch (error) {
      if (gen !== generation || error?.name === 'AbortError') return false;
      cloudError = error;
      if (error.code === 'NO_PROVIDERS') cloudUnavailableUntil = Date.now() + NO_PROVIDER_BACKOFF_MS;
      remaining = error.remainingText || text;
    }
  } else {
    cloudError = new SpeechError('NO_PROVIDERS', 'لا توجد خدمة صوت سحابية مضبوطة.');
  }

  lastSpeech = { engine: null, provider: null, error: cloudError?.message || null };
  if (!settings.deviceFallback) {
    throw new SpeechError(cloudError?.code || 'CLOUD_TTS_FAILED',
      `${cloudError?.message || 'تعذر الصوت السحابي.'} صوت الجهاز معطّل من الإعدادات؛ الرد متاح نصاً.`);
  }
  const played = await speakOnDevice(remaining);
  if (gen === generation) lastSpeech = { engine: 'device', provider: null, error: cloudError?.message || null };
  return played;
}

export function stopSpeaking() {
  generation += 1;
  activeController?.abort();
  activeController = null;
  const playback = activePlayback;
  activePlayback = null;
  if (audioElement) {
    try { audioElement.pause(); } catch {}
  }
  playback?.resolve(false);
  stopDeviceSpeech();
}

/** For the settings and setup screens: plays a sample and reports which engine spoke. */
export async function testVoice(text = 'مرحباً، أنا مساعدك. هذا اختبار للصوت.') {
  try {
    const success = await speak(text);
    const info = getLastSpeechInfo();
    return { success, engine: info.engine, provider: info.provider, cloudError: info.error, error: success ? null : 'لم يكتمل التشغيل.' };
  } catch (error) {
    return { success: false, engine: null, provider: null, cloudError: lastSpeech.error, error: error?.message || 'تعذر التشغيل.' };
  }
}

export async function listCloudProviders() {
  const token = await getAccessToken();
  if (!token) return [];
  const response = await fetch('/api/speech', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  return Array.isArray(data.providers) ? data.providers : [];
}
