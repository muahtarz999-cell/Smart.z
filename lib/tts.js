'use client';

const VOICE_STORAGE_KEY = 'smart-assistant-voice-id';
const LEGACY_CACHE_DATABASE = 'smart-assistant-speech';

let activeUtterance = null;
let resolveActiveUtterance = null;

function cleanTextForSpeech(text) {
  return String(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/`/g, '')
    .replace(/\\([\\`*_{}\[\]()#+.!>|~-])/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-+*]\s+)?\[(?:\s|x|X)\]\s+/gm, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, '')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/\[([^\]]+)\]/g, '$1')
    .replace(/\*\*|__|~~|[*_#~|]/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t]*\|[ \t]*:?-{3,}:?[ \t]*(?=\||$)/gm, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function getVoiceId(voice) {
  return voice.voiceURI || `${voice.name}::${voice.lang}`;
}

export function getArabicVoices() {
  if (typeof window === 'undefined' || !window.speechSynthesis) return [];
  return window.speechSynthesis
    .getVoices()
    .filter((voice) => voice.lang && voice.lang.toLowerCase().startsWith('ar'));
}

export function getSelectedVoiceId() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(VOICE_STORAGE_KEY);
  } catch (error) {
    console.warn('[TTS] Could not load the saved voice:', error);
    return null;
  }
}

export function saveSelectedVoiceId(voiceId) {
  if (typeof window === 'undefined') {
    throw new Error('Voice preferences are only available in the browser.');
  }
  if (voiceId) {
    window.localStorage.setItem(VOICE_STORAGE_KEY, voiceId);
  } else {
    window.localStorage.removeItem(VOICE_STORAGE_KEY);
  }
}

function pickVoice(selectedVoiceId) {
  const voices = window.speechSynthesis.getVoices();
  const selectedVoice = selectedVoiceId
    ? voices.find((voice) => getVoiceId(voice) === selectedVoiceId)
    : null;
  return (
    selectedVoice ||
    voices.find((voice) => voice.lang?.toLowerCase().startsWith('ar')) ||
    voices.find((voice) => voice.default) ||
    voices[0] ||
    null
  );
}

export async function speak(text, options = {}) {
  if (
    !text ||
    typeof window === 'undefined' ||
    !window.speechSynthesis ||
    typeof window.SpeechSynthesisUtterance === 'undefined'
  ) {
    return false;
  }

  const spokenText = cleanTextForSpeech(text);
  if (!spokenText) return false;

  stopSpeaking();
  const synthesis = window.speechSynthesis;

  return new Promise((resolve) => {
    const utterance = new window.SpeechSynthesisUtterance(spokenText);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (activeUtterance === utterance) {
        activeUtterance = null;
        resolveActiveUtterance = null;
      }
      resolve(result);
    };

    const voice = pickVoice(options.voiceId || getSelectedVoiceId());
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || 'ar-SA';
    utterance.rate = options.rate ?? 1;
    utterance.pitch = options.pitch ?? 1;
    utterance.volume = options.volume ?? 1;
    utterance.onend = () => finish(true);
    utterance.onerror = (event) => {
      console.error('[TTS] Device speech synthesis failed:', event.error);
      finish(false);
    };

    activeUtterance = utterance;
    resolveActiveUtterance = finish;
    synthesis.speak(utterance);
    if (synthesis.paused) synthesis.resume();
  });
}

export function stopSpeaking() {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  resolveActiveUtterance?.(false);
}

export function isSpeakingNow() {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.speechSynthesis?.speaking)
  );
}

export async function clearSpeechCache() {
  if (typeof indexedDB === 'undefined') return;

  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LEGACY_CACHE_DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('Could not clear the speech cache.'));
    request.onblocked = () => reject(new Error('Speech cache is open in another application tab.'));
  });
}
