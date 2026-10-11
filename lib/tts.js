'use client';

import { Capacitor, registerPlugin } from '@capacitor/core';

const MAX_CHUNK_CHARACTERS = 200;
const LEGACY_CACHE_DATABASE = 'smart-assistant-speech';
const VOICE_LOAD_TIMEOUT_MS = 2000;
const GULF_ARABIC_LOCALES = new Set(['ar-ae', 'ar-bh', 'ar-kw', 'ar-om', 'ar-qa']);

let activeSpeech = null;
let speechGeneration = 0;
let nativeSpeechPlugin = null;
let nativeStopPromise = Promise.resolve();
let lastTTSError = null;
let hasShownTTSSetupPrompt = false;
const SpeechEngineSetup = registerPlugin('SpeechEngineSetup');

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
    throw createSpeechError('النطق الصوتي غير مدعوم في هذا المتصفح.');
  }
  if (typeof window.SpeechSynthesisUtterance === 'undefined') {
    throw createSpeechError('واجهة النطق الصوتي غير متاحة في هذا الجهاز.');
  }
  return window.speechSynthesis;
}

function isNativeSpeechAvailable() {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('TextToSpeech');
}

function getArabicVoiceLanguages(voices) {
  return [...new Set(voices
    .map((voice) => String(voice.lang || '').replace(/_/g, '-'))
    .filter((language) => /^ar(?:-|$)/i.test(language)))]
    .sort((left, right) => left.localeCompare(right));
}

function getErrorMessage(error) {
  if (typeof error === 'string') return error;
  return error?.message || error?.localizedDescription || String(error || 'خطأ غير معروف');
}

export function isSpeechSupported() {
  return isNativeSpeechAvailable() || (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance !== 'undefined'
  );
}

export function canOpenSpeechEngineSettings() {
  return isNativeSpeechAvailable() && Capacitor.getPlatform() === 'android';
}

export function getLastTTSError() {
  return lastTTSError;
}

export function resetTTSError() {
  lastTTSError = null;
}

export function shouldShowTTSSetupPrompt() {
  return Capacitor.getPlatform() === 'android' && lastTTSError && !hasShownTTSSetupPrompt;
}

export async function getSpeechDiagnostics() {
  const platform = Capacitor.getPlatform();
  const capacitorNative = Capacitor.isNativePlatform();
  const textToSpeechPluginAvailable = capacitorNative
    && Capacitor.isPluginAvailable('TextToSpeech');

  const inspectEngine = async (available, loadVoices) => {
    if (!available) {
      return {
        available: false,
        getSupportedVoicesSucceeded: false,
        voiceCount: null,
        arabicLanguages: [],
        error: 'واجهة محرك النطق غير متاحة.',
      };
    }
    try {
      const voices = await loadVoices();
      return {
        available: true,
        getSupportedVoicesSucceeded: true,
        voiceCount: voices.length,
        arabicLanguages: getArabicVoiceLanguages(voices),
        error: null,
      };
    } catch (error) {
      return {
        available: true,
        getSupportedVoicesSucceeded: false,
        voiceCount: null,
        arabicLanguages: [],
        error: getErrorMessage(error),
      };
    }
  };

  const nativeEngine = textToSpeechPluginAvailable
    ? await inspectEngine(true, async () => {
      const plugin = await getNativeSpeechPlugin();
      const result = await plugin.getSupportedVoices();
      if (!Array.isArray(result?.voices)) {
        throw new Error('أعاد TextToSpeech نتيجة getSupportedVoices دون قائمة أصوات صالحة.');
      }
      return result.voices;
    })
    : {
      available: false,
      getSupportedVoicesSucceeded: false,
      voiceCount: null,
      arabicLanguages: [],
      error: 'إضافة TextToSpeech الأصلية غير متاحة على هذه المنصة.',
    };

  const browserAvailable = typeof window !== 'undefined'
    && typeof window.speechSynthesis !== 'undefined'
    && typeof window.SpeechSynthesisUtterance !== 'undefined';
  const browserEngine = await inspectEngine(browserAvailable, async () => {
    const synthesis = getSpeechSynthesis();
    return getAvailableVoices(synthesis);
  });

  return {
    platform,
    capacitorNative,
    textToSpeechPluginAvailable,
    browserSpeechSynthesisAvailable: browserAvailable,
    nativeEngine,
    browserEngine,
  };
}

async function getNativeSpeechPlugin() {
  if (!isNativeSpeechAvailable()) {
    throw createSpeechError('إضافة النطق الأصلية غير متاحة. أعد مزامنة مشروع Android وثبّت أحدث نسخة من التطبيق.');
  }
  if (!nativeSpeechPlugin) {
    const { TextToSpeech } = await import('@capacitor-community/text-to-speech');
    nativeSpeechPlugin = TextToSpeech;
  }
  return nativeSpeechPlugin;
}

export async function openSpeechEngineSettings() {
  if (!canOpenSpeechEngineSettings()) {
    throw new Error('إعداد محرك النطق متاح في تطبيق Android فقط.');
  }
  hasShownTTSSetupPrompt = true;
  try {
    return await SpeechEngineSetup.openInstall();
  } catch (error) {
    console.error('[TTS] Failed to open Android speech-data installer:', error);
    throw createSpeechError(`تعذر فتح تثبيت بيانات الصوت: ${getErrorMessage(error)}`);
  }
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

async function getNativeVoices(plugin) {
  const deadline = Date.now() + VOICE_LOAD_TIMEOUT_MS;
  let lastError;
  let voices = [];
  do {
    try {
      const result = await plugin.getSupportedVoices();
      voices = Array.isArray(result.voices) ? result.voices : [];
      if (voices.some((voice) => getArabicLocale(voice) !== null)) return voices;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);

  if (voices.length) return voices;
  throw createSpeechError(
    `تعذر تهيئة محرك النطق في Android. تحقق من تثبيت محرك تحويل النص إلى كلام على الجهاز ثم أعد المحاولة.`
  );
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
  const native = isNativeSpeechAvailable();
  const platform = Capacitor.getPlatform();
  let plugin = null;
  let synthesis = null;
  let voices = [];
  let useNative = false;

  try {
    if (native) {
      try {
        plugin = await getNativeSpeechPlugin();
        voices = await getNativeVoices(plugin);
        useNative = true;
      } catch (nativeError) {
        console.warn('[TTS] Native speech failed, falling back to browser:', getErrorMessage(nativeError));
        lastTTSError = nativeError;
        if (platform === 'android') {
          hasShownTTSSetupPrompt = false;
        }
      }
    }

    if (!useNative || voices.length === 0) {
      synthesis = getSpeechSynthesis();
      voices = await getAvailableVoices(synthesis);
      useNative = false;
    }
  } catch (error) {
    console.error('[TTS] Failed to find voices:', error);
    throw createSpeechError('تعذر العثور على أصوات النطق. تأكد من تفعيل النطق في إعدادات الجهاز.');
  }

  const arabicVoices = voices.filter((voice) => getArabicLocale(voice) !== null);

  if (!arabicVoices.length) {
    const setupHint = useNative && platform === 'android'
      ? ' استخدم زر إعداد محرك النطق لتثبيت البيانات الصوتية العربية.'
      : ' ثبّت صوتًا عربيًا في إعدادات الجهاز ثم أعد المحاولة.';
    const error = createSpeechError(`لم يعثر محرك النطق على صوت عربي.${setupHint}`);
    lastTTSError = error;
    throw error;
  }

  arabicVoices.sort((left, right) => (
    Number(right.localService === true) - Number(left.localService === true)
      || scoreArabicVoice(right) - scoreArabicVoice(left)
      || String(left.name).localeCompare(String(right.name), 'ar')
  ));
  const voice = arabicVoices[0];
  lastTTSError = null;
  return {
    voice,
    native: useNative,
    plugin,
    synthesis,
    voiceIndex: useNative ? voices.indexOf(voice) : undefined,
  };
}

export async function getArabicVoiceInfo() {
  const { voice, native } = await findBestArabicVoice();
  return {
    name: voice.name || voice.voiceURI,
    language: voice.lang || 'ar',
    localService: voice.localService,
    native,
  };
}

function createSpeechError(message) {
  const error = new Error(message);
  error.name = 'SpeechSynthesisError';
  return error;
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
      finish(false, createSpeechError(
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
        finish(false, createSpeechError(
          `فشل محرك النطق في ${Capacitor.getPlatform()}: ${error?.message || 'خطأ غير معروف'}.`
        ));
      });
  });
}

export async function speak(text) {
  if (!text || typeof window === 'undefined') return false;
  const spokenText = cleanTextForSpeech(text);
  if (!spokenText) return false;

  try {
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
  } catch (error) {
    if (error?.name === 'SpeechSynthesisError') throw error;
    throw createSpeechError(error?.message || 'تعذر تشغيل النطق الصوتي.');
  }
}

export async function testSpeechPlayback(text) {
  const engine = isNativeSpeechAvailable()
    ? Capacitor.getPlatform() === 'android' ? 'android-native' : 'native-plugin'
    : 'browser';
  try {
    const completed = await speak(text);
    return completed
      ? { success: true, engine, error: null }
      : { success: false, engine, error: 'لم يكتمل حدث النطق؛ لم يُسجّل التشغيل نجاحًا.' };
  } catch (error) {
    return { success: false, engine, error: getErrorMessage(error) };
  }
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
        console.warn('[TTS] Previous native speech stop failed:', error);
      })
      .then(() => nativeSpeechPlugin.stop())
      .catch((error) => {
        console.error('[TTS] Could not stop native speech:', error);
      });
  }
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
