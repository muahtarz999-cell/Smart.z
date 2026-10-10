'use client';

const MAX_CHUNK_CHARACTERS = 200;
const LEGACY_CACHE_DATABASE = 'smart-assistant-speech';
const VOICE_LOAD_TIMEOUT_MS = 2000;
const GULF_ARABIC_LOCALES = new Set(['ar-ae', 'ar-bh', 'ar-kw', 'ar-om', 'ar-qa']);

let activeSpeech = null;
let speechGeneration = 0;

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

function splitSpeechText(text) {
  const chunks = [];
  let current = '';

  for (const word of text.split(/\s+/u)) {
    const wordCharacters = Array.from(word);
    while (wordCharacters.length > MAX_CHUNK_CHARACTERS) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(wordCharacters.splice(0, MAX_CHUNK_CHARACTERS).join(''));
    }

    const next = current ? `${current} ${wordCharacters.join('')}` : wordCharacters.join('');
    if (Array.from(next).length > MAX_CHUNK_CHARACTERS) {
      if (current) chunks.push(current);
      current = wordCharacters.join('');
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function getSpeechSynthesis() {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    throw new Error('النطق الصوتي غير مدعوم في هذا المتصفح.');
  }
  if (typeof window.SpeechSynthesisUtterance === 'undefined') {
    throw new Error('واجهة النطق الصوتي غير متاحة في هذا الجهاز.');
  }
  return window.speechSynthesis;
}

async function getAvailableVoices(synthesis) {
  let voices = synthesis.getVoices();
  if (voices.some((voice) => getArabicLocale(voice) !== null)) return voices;

  await new Promise((resolve) => {
    let settled = false;
    let timeoutId;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      synthesis.removeEventListener?.('voiceschanged', finish);
      resolve();
    };

    timeoutId = setTimeout(finish, VOICE_LOAD_TIMEOUT_MS);
    synthesis.addEventListener?.('voiceschanged', finish, { once: true });
    voices = synthesis.getVoices();
    if (voices.some((voice) => getArabicLocale(voice) !== null)) finish();
  });

  return synthesis.getVoices();
}

function getArabicLocale(voice) {
  const [language, region] = String(voice.lang || '')
    .replace(/_/g, '-')
    .toLowerCase()
    .split('-');
  if (language !== 'ar' || region === 'jo') return null;
  return region ? `${language}-${region}` : language;
}

function scoreArabicVoice(voice) {
  const locale = getArabicLocale(voice);
  if (locale === 'ar-sa') return 60;
  if (GULF_ARABIC_LOCALES.has(locale)) return 50;
  return 20;
}

async function findBestArabicVoice() {
  const synthesis = getSpeechSynthesis();
  const voices = await getAvailableVoices(synthesis);
  const arabicVoices = voices.filter((voice) => (
    getArabicLocale(voice) !== null
  ));

  if (!arabicVoices.length) {
    throw new Error('لم يعثر محرك النطق على صوت عربي. ثبّت صوتًا عربيًا في إعدادات الجهاز ثم أعد المحاولة.');
  }

  arabicVoices.sort((left, right) => (
    scoreArabicVoice(right) - scoreArabicVoice(left)
      || Number(right.localService === true) - Number(left.localService === true)
      || String(left.name).localeCompare(String(right.name), 'ar')
  ));
  return arabicVoices[0];
}

export async function getArabicVoiceInfo() {
  const voice = await findBestArabicVoice();
  return {
    name: voice.name || voice.voiceURI,
    language: voice.lang || 'ar',
    localService: voice.localService === true,
  };
}

function speakChunk(chunk, voice, generation, synthesis) {
  return new Promise((resolve, reject) => {
    const utterance = new window.SpeechSynthesisUtterance(chunk);
    utterance.voice = voice;
    utterance.lang = voice.lang || 'ar';
    const playback = { utterance, resolve };
    const finish = (result, error) => {
      if (activeSpeech !== playback) return;
      activeSpeech = null;
      utterance.onend = null;
      utterance.onerror = null;
      if (error) reject(error);
      else resolve(result);
    };

    if (generation !== speechGeneration) {
      resolve(false);
      return;
    }

    activeSpeech = playback;
    utterance.onend = () => finish(true);
    utterance.onerror = (event) => {
      if (event?.error === 'canceled' || event?.error === 'interrupted') {
        finish(false);
        return;
      }
      finish(false, new Error(
        event?.error === 'not-allowed'
          ? 'لم يسمح النظام بتشغيل النطق الصوتي.'
          : `تعذر نطق الرد بالصوت العربي المتاح (${event?.error || 'خطأ غير معروف'}).`
      ));
    };

    try {
      synthesis.speak(utterance);
    } catch (error) {
      finish(false, error);
    }
  });
}

export async function speak(text) {
  if (!text || typeof window === 'undefined') return false;
  const spokenText = cleanTextForSpeech(text);
  if (!spokenText) return false;

  stopSpeaking();
  const generation = ++speechGeneration;
  const synthesis = getSpeechSynthesis();
  const voice = await findBestArabicVoice();
  if (generation !== speechGeneration) return false;

  for (const chunk of splitSpeechText(spokenText)) {
    const played = await speakChunk(chunk, voice, generation, synthesis);
    if (generation !== speechGeneration || !played) return false;
  }
  return true;
}

export function stopSpeaking() {
  speechGeneration += 1;
  const playback = activeSpeech;
  activeSpeech = null;
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  playback?.resolve(false);
}

export function isSpeakingNow() {
  return typeof window !== 'undefined' && activeSpeech !== null;
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
