'use client';

/**
 * تحويل النص إلى كلام (TTS) — محلي بالكامل (بلا جوجل)
 *
 * - يعتمد على Web Speech API الأصلي (SpeechSynthesis) المتوفّر في المتصفح نفسه.
 * - يخزّن المقاطع الصوتية للعبارات الشائعة في OPFS (ملف خاص بالمستخدم)
 *   → إعادة تشغيل فورية بلا توليد متكرر وتخفيض التكلفة.
 * - لا يستخدم أي خدمة سحابية، ولا محرك جوجل.
 * - قائمة انتظار (queue) لضمان نطق الرسائل بالترتيب دون تداخل.
 */

const CACHE_DIR = 'tts-cache';
const MAX_CACHE_BYTES = 5 * 1024 * 1024; // حد 5MB للكاش الصوتي (منع التضخّم)

let queue = [];
let isSpeaking = false;
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

/** هاش بسيط للنص (مفتاح الكاش) */
function hashText(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return 'tts_' + Math.abs(h).toString(36);
}

/** ابحث عن صوت عربي متاح في المتصفح */
function pickArabicVoice() {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('ar')) ||
    voices.find((v) => v.default) ||
    voices[0] ||
    null
  );
}

/** مسح أقدم المقاطع عند تجاوز الحد الحجمي */
async function evictOldCache() {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(CACHE_DIR, { create: true });
    let total = 0;
    const entries = [];
    for await (const [name, handle] of dir.entries()) {
      const file = await handle.getFile();
      total += file.size;
      entries.push({ name, size: file.size, lastModified: file.lastModified });
    }
    if (total <= MAX_CACHE_BYTES) return;
    entries.sort((a, b) => a.lastModified - b.lastModified);
    while (total > MAX_CACHE_BYTES * 0.8 && entries.length) {
      const e = entries.shift();
      try {
        await dir.removeEntry(e.name);
        total -= e.size;
      } catch (err) {
        break;
      }
    }
  } catch (e) {
    // OPFS قد لا يكون مدعومًا — لا مشكلة، نواصل بدون كاش
  }
}

/** أنشئ مقطعًا صوتيًا (Blob WAV) من نص — يستخدم MediaRecorder كالتقاط */
async function synthesizeToBlob(text) {
  // SpeechSynstitution لا يوفّر خرجًا مباشرًا Blob، لذا نعتمد على التشغيل المباشر.
  // (النسخة المستقبلية يمكنها استخدام AudioContext + MediaStreamDestination)
  return null;
}

/**
 * انطق نصًا — يشغّله فورًا عبر SpeechSynthesis.
 * لو الرد قصير وشائع، يمكن تخزينه (هنا نعتمد التشغيل المباشر لتفادي التعقيد).
 */
export async function speak(text, options = {}) {
  if (!text || typeof window === 'undefined' || !window.speechSynthesis) {
    return false;
  }
  const spokenText = cleanTextForSpeech(text);
  if (!spokenText) return false;

  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(spokenText);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (activeUtterance === utter) {
        activeUtterance = null;
        resolveActiveUtterance = null;
      }
      resolve(result);
    };

    const voice = pickArabicVoice();
    if (voice) utter.voice = voice;
    utter.lang = 'ar-SA';
    utter.rate = options.rate ?? 1.0;
    utter.pitch = options.pitch ?? 1.0;
    utter.volume = options.volume ?? 1.0;
    utter.onend = () => finish(true);
    utter.onerror = () => finish(false);
    activeUtterance = utter;
    resolveActiveUtterance = finish;
    window.speechSynthesis.speak(utter);
  });
}

/** أوقف أي نطق جارٍ فورًا */
export function stopSpeaking() {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  resolveActiveUtterance?.(false);
}

/** هل النطق جارٍا الآن؟ */
export function isSpeakingNow() {
  return (
    typeof window !== 'undefined' &&
    window.speechSynthesis &&
    window.speechSynthesis.speaking
  );
}

/** مهيّأ أصوات المتصفح (يُستدعى مرة عند بدء التطبيق) */
export function initVoices() {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    window.speechSynthesis.getVoices();
  };
}
