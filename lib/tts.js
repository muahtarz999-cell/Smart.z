'use client';

import { Capacitor } from '@capacitor/core';

const MAX_CHUNK_CHARACTERS = 200;
const LEGACY_CACHE_DATABASE = 'smart-assistant-speech';
const GULF_ARABIC_LOCALES = new Set(['ar-ae', 'ar-bh', 'ar-kw', 'ar-om', 'ar-qa']);

let activeSpeech = null;
let speechGeneration = 0;
let nativeSpeechPlugin = null;
let nativeStopPromise = Promise.resolve();

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

function isNativeSpeechAvailable() {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('TextToSpeech');
}

export function isSpeechSupported() {
  return isNativeSpeechAvailable() || (
    typeof window !== 'undefined'
    && typeof window.speechSynthesis !== 'undefined'
    && typeof window.SpeechSynthesisUtterance !== 'undefined'
  );
}

async function getNativeSpeechPlugin() {
  if (!isNativeSpeechAvailable()) {
    throw new Error('إضافة TextToSpeech غير مسجلة في التطبيق. أعد مزامنة Capacitor وثبّت APK جديدًا.');
  }
  if (!nativeSpeechPlugin) {
    const { TextToSpeech } = await import('@capacitor-community/text-to-speech');
    nativeSpeechPlugin = TextToSpeech;
  }
  return nativeSpeechPlugin;
}

async function getAvailableVoices(synthesis) {
  const voices = synthesis.getVoices();
  if (voices.length) return voices;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      synthesis.removeEventListener?.('voiceschanged', finish);
      resolve();
    };
    const timeout = setTimeout(finish, 1500);
    synthesis.addEventListener?.('voiceschanged', finish, { once: true });
  });

  return synthesis.getVoices();
}

function scoreArabicVoice(voice) {
  const language = String(voice.lang || '').replace(/_/g, '-').toLowerCase();
  return language === 'ar-sa' ? 60 : GULF_ARABIC_LOCALES.has(language) ? 50 : 20;
}

function getArabicVoices(voices) {
  return voices.filter((voice) => {
    const language = String(voice.lang || '').replace(/_/g, '-').toLowerCase();
    return /^ar(?:-|$)/.test(language) && language !== 'ar-jo';
  });
}

function chooseArabicVoice(voices) {
  const arabicVoices = getArabicVoices(voices);
  arabicVoices.sort((left, right) => (
    scoreArabicVoice(right) - scoreArabicVoice(left)
      || String(left.name).localeCompare(String(right.name), 'ar')
  ));
  return arabicVoices[0] || null;
}

async function findBestArabicVoice() {
  if (isNativeSpeechAvailable()) {
    const plugin = await getNativeSpeechPlugin();
    const { voices = [] } = await plugin.getSupportedVoices();
    const voice = chooseArabicVoice(voices);
    if (voice) {
      return {
        voice,
        native: true,
        plugin,
        voiceIndex: voices.indexOf(voice),
      };
    }
  }

  const synthesis = getSpeechSynthesis();
  const voices = await getAvailableVoices(synthesis);
  const voice = chooseArabicVoice(voices);

  if (!voice) {
    throw new Error('لم يعثر الجهاز على صوت عربي متاح. ثبّت بيانات صوت عربي من إعدادات النظام ثم أعد المحاولة.');
  }

  return { voice, native: false, synthesis };
}

export async function getArabicVoiceInfo() {
  const { voice, native } = await findBestArabicVoice();
  return {
    name: voice.name || voice.voiceURI,
    language: voice.lang || 'ar',
    native,
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
      if (event.error === 'canceled' || event.error === 'interrupted') {
        finish(false);
        return;
      }
      finish(false, new Error(
        event.error === 'not-allowed'
          ? 'لم يسمح النظام بتشغيل النطق الصوتي.'
          : `تعذر نطق الرد بالصوت العربي المتاح (${event.error || 'خطأ غير معروف'}).`
      ));
    };

    try {
      synthesis.speak(utterance);
    } catch (error) {
      finish(false, error);
    }
  });
}

function speakNativeChunk(chunk, selection, generation) {
  return new Promise((resolve, reject) => {
    const playback = { resolve };
    const finish = (result, error) => {
      if (activeSpeech !== playback) return;
      activeSpeech = null;
      if (error) reject(error);
      else resolve(result);
    };

    if (generation !== speechGeneration) {
      resolve(false);
      return;
    }

    activeSpeech = playback;
    nativeStopPromise
      .then(() => {
        if (generation !== speechGeneration) {
          finish(false);
          return null;
        }
        return selection.plugin.speak({
          text: chunk,
          lang: selection.voice.lang || 'ar',
          voice: selection.voiceIndex,
          queueStrategy: 0,
        });
      })
      .then((result) => {
        if (result !== null) finish(true);
      })
      .catch((error) => {
        finish(false, new Error(`تعذر تشغيل النطق الأصلي: ${error?.message || 'خطأ غير معروف'}`));
      });
  });
}

export async function speak(text) {
  if (!text || typeof window === 'undefined') return false;
  const spokenText = cleanTextForSpeech(text);
  if (!spokenText) return false;

  stopSpeaking();
  const generation = ++speechGeneration;
  const selection = await findBestArabicVoice();
  if (generation !== speechGeneration) return false;

  for (const chunk of splitSpeechText(spokenText)) {
    const played = selection.native
      ? await speakNativeChunk(chunk, selection, generation)
      : await speakChunk(chunk, selection.voice, generation, selection.synthesis);
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
  if (nativeSpeechPlugin) {
    nativeStopPromise = nativeStopPromise
      .catch((error) => {
        console.warn('[TTS] Previous native stop failed:', error);
      })
      .then(() => nativeSpeechPlugin.stop())
      .catch((error) => {
        console.error('[TTS] Could not stop native speech:', error);
      });
  }
}

export function isSpeakingNow() {
  return activeSpeech !== null;
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
