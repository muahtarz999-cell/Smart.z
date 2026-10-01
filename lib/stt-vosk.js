'use client';

/**
 * محرك التعرّف على الكلام (STT) عبر Vosk-WASM
 */

const MODEL_BASE_URL = 'https://alphacephei.com/vosk/models/vosk-model-ar-mgb2-0.4.zip';
const MODEL_DIR_NAME = 'vosk-model-ar-mgb2-0.4';
const OPFS_DIR = 'vosk-models';

let voskModulePromise = null;
let recognizerPromise = null;

async function loadVoskModule() {
  if (voskModulePromise) return voskModulePromise;
  voskModulePromise = (async () => {
    if (typeof window === 'undefined') return null;
    if (!window.Vosk) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/vosk@0.0.8/dist/vosk.js';
        s.async = true;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
      if (window.Vosk?.locateFile) {
        window.Vosk.locateFile = (file) =>
          `https://cdn.jsdelivr.net/npm/vosk@0.0.8/dist/${file}`;
      }
    }
    return window.Vosk;
  })();
  return voskModulePromise;
}

async function ensureModelDownloaded(onProgress) {
  let root;
  try {
    root = await navigator.storage.getDirectory();
  } catch (e) {
    throw new Error('OPFS غير مدعوم');
  }
  const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  try {
    await dir.getDirectoryHandle(MODEL_DIR_NAME, { create: false });
    return true;
  } catch (e) {
    // غير موجود
  }

  onProgress?.({ stage: 'downloading', percent: 0 });
  const resp = await fetch(MODEL_BASE_URL);
  if (!resp.ok) throw new Error('فشل التنزيل');
  const total = Number(resp.headers.get('content-length')) || 0;
  const reader = resp.body.getReader();

  const zipHandle = await dir.getFileHandle('model.zip', { create: true });
  const writable = await zipHandle.createWritable();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    await writable.write(value);
    if (total > 0)
      onProgress?.({ stage: 'downloading', percent: received / total });
  }
  await writable.close();

  onProgress?.({ stage: 'extracting' });
  const file = await zipHandle.getFile();
  const buf = await file.arrayBuffer();
  await extractZip(buf, dir);
  await dir.removeEntry('model.zip');
  onProgress?.({ stage: 'done' });
  return true;
}

async function extractZip(buffer, dirHandle) {
  // استيراد ديناميكي لتجنب webpack error
  const fflateUrl = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
  const module = await import(fflateUrl);
  const { unzipSync } = module;
  const files = unzipSync(new Uint8Array(buffer));
  for (const [path, data] of Object.entries(files)) {
    const parts = path.split('/');
    const fname = parts[parts.length - 1];
    if (!fname) continue;
    let cur = dirHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = await cur.getDirectoryHandle(parts[i], { create: true });
    }
    const fh = await cur.getFileHandle(fname, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }
}

export async function getRecognizer(onProgress) {
  if (recognizerPromise) return recognizerPromise;
  recognizerPromise = (async () => {
    const Vosk = await loadVoskModule();
    if (!Vosk) throw new Error('Vosk غير متاح');
    await ensureModelDownloaded(onProgress);
    const modelPath = `/${OPFS_DIR}/${MODEL_DIR_NAME}`;
    const model = await new Vosk.Model(modelPath);
    const recognizer = new Vosk.Recognizer({ model, sampleRate: 16000 });
    recognizer.setWords(true);
    return recognizer;
  })();
  return recognizerPromise;
}

function float32ToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

export async function transcribe(pcm16k) {
  const recognizer = await getRecognizer();
  const buf = float32ToInt16(pcm16k);
  if (recognizer.acceptWaveform) recognizer.acceptWaveform(buf);
  else recognizer.acceptWaveForm(buf);
  const result = JSON.parse(
    recognizer.getResult ? recognizer.getResult() : recognizer.finalResult()
  );
  return (result.text || '').trim();
}

export async function createStreamRecognizer() {
  const recognizer = await getRecognizer();
  return {
    feed(pcmFloat32) {
      const buf = float32ToInt16(pcmFloat32);
      if (recognizer.acceptWaveform) recognizer.acceptWaveform(buf);
      else recognizer.acceptWaveForm(buf);
    },
    partial() {
      const r = JSON.parse(
        recognizer.getPartialResult
          ? recognizer.getPartialResult()
          : recognizer.partialResult()
      );
      return (r.partial || '').trim();
    },
    finalText() {
      const r = JSON.parse(
        recognizer.getResult ? recognizer.getResult() : recognizer.finalResult()
      );
      return (r.text || '').trim();
    },
  };
}
