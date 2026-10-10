'use client';

/** Groq TTS with a device-local cache of previously generated speech clips. */
const CACHE_DATABASE = 'smart-assistant-speech';
const CACHE_STORE = 'clips';
const MAX_CACHE_BYTES = 5 * 1024 * 1024; // حد 5MB للكاش الصوتي (منع التضخّم)
const VOICE_STORAGE_KEY = 'smart-assistant-voice-id';
const DEFAULT_VOICE_ID = 'noura';
const MAX_CHUNK_CHARACTERS = 200;

export const ARABIC_SPEECH_VOICES = Object.freeze([
  { id: 'abdullah', name: 'عبدالله', lang: 'ar-SA' },
  { id: 'fahad', name: 'فهد', lang: 'ar-SA' },
  { id: 'sultan', name: 'سلطان', lang: 'ar-SA' },
  { id: 'lulwa', name: 'لولوة', lang: 'ar-SA' },
  { id: 'noura', name: 'نورة', lang: 'ar-SA' },
  { id: 'aisha', name: 'عائشة', lang: 'ar-SA' },
]);

let cacheDatabasePromise = null;
let activePlayback = null;
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

export function getVoiceId(voice) {
  return voice.id;
}

export function getArabicVoices() {
  return [...ARABIC_SPEECH_VOICES];
}

export function getSelectedVoiceId() {
  if (typeof window === 'undefined') return null;
  try {
    const voiceId = window.localStorage.getItem(VOICE_STORAGE_KEY);
    return ARABIC_SPEECH_VOICES.some((voice) => voice.id === voiceId) ? voiceId : null;
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
    if (!ARABIC_SPEECH_VOICES.some((voice) => voice.id === voiceId)) {
      throw new TypeError('Unsupported Groq Arabic voice.');
    }
    window.localStorage.setItem(VOICE_STORAGE_KEY, voiceId);
  } else {
    window.localStorage.removeItem(VOICE_STORAGE_KEY);
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Speech cache request failed.'));
  });
}

function transactionCompletion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Speech cache transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Speech cache transaction aborted.'));
  });
}

function openSpeechCache() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable.'));
  }
  if (cacheDatabasePromise) return cacheDatabasePromise;

  cacheDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CACHE_STORE)) {
        request.result.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        cacheDatabasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      cacheDatabasePromise = null;
      reject(request.error || new Error('Could not open the speech cache.'));
    };
  });

  return cacheDatabasePromise;
}

async function getCachedAudio(key) {
  const database = await openSpeechCache();
  const transaction = database.transaction(CACHE_STORE, 'readonly');
  const done = transactionCompletion(transaction);
  const record = await requestResult(transaction.objectStore(CACHE_STORE).get(key));
  await done;
  return record?.audio instanceof Blob ? record.audio : null;
}

async function cacheAudio(key, audio) {
  if (audio.size > MAX_CACHE_BYTES) return;

  const database = await openSpeechCache();
  const readTransaction = database.transaction(CACHE_STORE, 'readonly');
  const readDone = transactionCompletion(readTransaction);
  const records = await requestResult(readTransaction.objectStore(CACHE_STORE).getAll());
  await readDone;

  const candidates = records
    .filter((record) => record.key !== key)
    .sort((left, right) => left.savedAt - right.savedAt);
  let totalBytes = audio.size + records
    .filter((record) => record.key !== key)
    .reduce((total, record) => total + record.size, 0);
  const evictedKeys = [];
  while (totalBytes > MAX_CACHE_BYTES && candidates.length) {
    const oldest = candidates.shift();
    totalBytes -= oldest.size;
    evictedKeys.push(oldest.key);
  }

  const transaction = database.transaction(CACHE_STORE, 'readwrite');
  const done = transactionCompletion(transaction);
  const store = transaction.objectStore(CACHE_STORE);
  for (const evictedKey of evictedKeys) store.delete(evictedKey);
  store.put({ key, audio, size: audio.size, savedAt: Date.now() });
  await done;
}

async function getAudioCacheKey(text, voiceId, cacheNamespace) {
  if (!globalThis.crypto?.subtle) return null;
  const data = new TextEncoder().encode(`groq-tts-v1\u0000${cacheNamespace}\u0000${voiceId}\u0000${text}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
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

async function fetchSpeechAudio(text, voiceId, accessToken, cacheNamespace) {
  const cacheKey = await getAudioCacheKey(text, voiceId, cacheNamespace).catch((error) => {
    console.warn('[TTS] Could not create a local cache key:', error);
    return null;
  });

  if (cacheKey) {
    try {
      const cachedAudio = await getCachedAudio(cacheKey);
      if (cachedAudio) return cachedAudio;
    } catch (error) {
      console.warn('[TTS] Could not read local speech cache:', error);
    }
  }

  if (!accessToken) throw new Error('يلزم تسجيل الدخول لتوليد الصوت.');
  const response = await fetch('/api/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text, voice: voiceId }),
    cache: 'no-store',
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.message || 'تعذر توليد الصوت من Groq.');
  }

  const audio = await response.blob();
  if (!audio.size || !audio.type.includes('audio')) {
    throw new Error('استجابة الصوت غير صالحة.');
  }
  if (cacheKey) {
    try {
      await cacheAudio(cacheKey, audio);
    } catch (error) {
      console.warn('[TTS] Could not save generated speech on this device:', error);
    }
  }
  return audio;
}

function playAudio(audioBlob) {
  return new Promise((resolve, reject) => {
    if (typeof Audio === 'undefined' || typeof URL.createObjectURL !== 'function') {
      reject(new Error('تشغيل الصوت غير مدعوم في بيئة التطبيق.'));
      return;
    }

    const url = URL.createObjectURL(audioBlob);
    const audio = new Audio(url);
    const playback = { audio, url, resolve };
    const finish = (result, error) => {
      if (activePlayback !== playback) return;
      activePlayback = null;
      audio.onended = null;
      audio.onerror = null;
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(result);
    };

    activePlayback = playback;
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false, new Error('تعذر تشغيل ملف الصوت على هذا الجهاز.'));
    audio.play().catch((error) => finish(false, error));
  });
}

/**
 * توليد الصوت عبر Groq ثم تشغيله، مع حفظ المقاطع على الجهاز لإعادة استخدامها.
 */
export async function speak(text, options = {}) {
  if (!text || typeof window === 'undefined') return false;
  const spokenText = cleanTextForSpeech(text);
  if (!spokenText) return false;

  stopSpeaking();
  const generation = ++speechGeneration;
  const voiceId = options.voiceId || DEFAULT_VOICE_ID;
  for (const chunk of splitSpeechText(spokenText)) {
    const audio = await fetchSpeechAudio(
      chunk,
      voiceId,
      options.accessToken,
      options.cacheNamespace || 'anonymous'
    );
    if (generation !== speechGeneration) return false;
    const played = await playAudio(audio);
    if (generation !== speechGeneration) return false;
    if (!played) return false;
  }
  return true;
}

/** أوقف أي نطق جارٍ فورًا */
export function stopSpeaking() {
  speechGeneration += 1;
  if (activePlayback) {
    const playback = activePlayback;
    activePlayback = null;
    playback.audio.pause();
    playback.audio.removeAttribute('src');
    URL.revokeObjectURL(playback.url);
    playback.resolve(false);
  }
}

/** هل النطق جارٍا الآن؟ */
export function isSpeakingNow() {
  return (
    typeof window !== 'undefined' &&
    activePlayback !== null
  );
}

export async function clearSpeechCache() {
  if (typeof indexedDB === 'undefined') return;
  if (cacheDatabasePromise) {
    const database = await cacheDatabasePromise;
    database.close();
    cacheDatabasePromise = null;
  }

  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(CACHE_DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('Could not clear the speech cache.'));
    request.onblocked = () => reject(new Error('Speech cache is open in another application tab.'));
  });
}
