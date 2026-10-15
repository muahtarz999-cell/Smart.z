'use client';

/**
 * Records everything between start() and stop() as 16 kHz mono PCM.
 *
 * Why not voice-activity detection: on a phone the user decides when the
 * sentence ends. Cutting on silence split sentences and dropped the first
 * syllable; a recorder that keeps every sample between press and release
 * does neither.
 *
 * The microphone is opened per turn and fully released by stop(). While the
 * microphone is open, Android and iOS switch audio to "call mode" (earpiece,
 * low volume), so speaking a reply with the microphone open is inaudible.
 */

const TARGET_SAMPLE_RATE = 16000;

export class VoiceRecorderError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'VoiceRecorderError';
    this.code = code;
    this.cause = cause;
  }
}

export function microphoneError(error) {
  const name = error?.name;
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(name)) {
    return new VoiceRecorderError('MIC_DENIED', 'لم يُسمح باستخدام الميكروفون. فعّله من إعدادات التطبيق ثم أعد المحاولة.', error);
  }
  if (['NotFoundError', 'DevicesNotFoundError'].includes(name)) {
    return new VoiceRecorderError('MIC_MISSING', 'لم يُعثر على ميكروفون في هذا الجهاز.', error);
  }
  if (['NotReadableError', 'TrackStartError', 'AbortError'].includes(name)) {
    return new VoiceRecorderError('MIC_BUSY', 'الميكروفون مستخدم في تطبيق آخر (مكالمة أو تسجيل). أغلقه ثم أعد المحاولة.', error);
  }
  return new VoiceRecorderError('MIC_FAILED', 'تعذر تشغيل الميكروفون.', error);
}

export function isRecordingSupported() {
  return typeof window !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && Boolean(window.AudioContext || window.webkitAudioContext);
}

/** Asks for microphone permission once and releases the microphone immediately. */
export async function requestMicrophonePermission() {
  if (!isRecordingSupported()) {
    throw new VoiceRecorderError('UNSUPPORTED', 'التسجيل الصوتي غير مدعوم هنا. استخدم التطبيق أو متصفحاً حديثاً عبر https.');
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return 'granted';
  } catch (error) {
    throw microphoneError(error);
  }
}

export async function getMicrophonePermissionState() {
  try {
    const status = await navigator.permissions?.query({ name: 'microphone' });
    return status?.state || 'unknown'; // granted | denied | prompt
  } catch {
    return 'unknown'; // Safari and some WebViews do not expose microphone permission state
  }
}

export function resample(samples, fromRate) {
  if (fromRate === TARGET_SAMPLE_RATE) return samples;
  const ratio = fromRate / TARGET_SAMPLE_RATE;
  const length = Math.floor(samples.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    // Average the source window: a cheap low-pass that avoids aliasing when downsampling 48k -> 16k.
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += samples[j];
    output[i] = end > start ? sum / (end - start) : samples[start] || 0;
  }
  return output;
}

export function encodeWav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export class VoiceRecorder {
  constructor({ maxDurationMs = 60_000, minDurationMs = 400, onLevel, onAutoStop } = {}) {
    this.maxDurationMs = maxDurationMs;
    this.minDurationMs = minDurationMs;
    this.onLevel = onLevel || (() => {});
    this.onAutoStop = onAutoStop || (() => {});
    this.state = 'idle'; // idle | starting | recording
    this._reset();
  }

  _reset() {
    this.context = null;
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.sink = null;
    this.chunks = [];
    this.startedAt = 0;
    this.maxTimer = null;
    this.startPromise = null;
    this.cancelled = false;
  }

  /**
   * Call synchronously from the press/tap handler: the AudioContext is created
   * and resumed before the first await so iOS treats it as user-initiated.
   */
  start() {
    if (this.state !== 'idle') return this.startPromise || Promise.resolve(false);
    if (!isRecordingSupported()) {
      return Promise.reject(new VoiceRecorderError('UNSUPPORTED', 'التسجيل الصوتي غير مدعوم هنا.'));
    }
    this.state = 'starting';
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContextClass();
    const resumed = this.context.resume?.().catch(() => {});

    this.startPromise = (async () => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
      } catch (error) {
        this._release();
        throw microphoneError(error);
      }
      await resumed;
      if (this.cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        this._release();
        return false;
      }

      this.stream = stream;
      this.source = this.context.createMediaStreamSource(stream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.sink = this.context.createGain();
      this.sink.gain.value = 0; // keeps the graph running without playing the microphone back
      this.processor.onaudioprocess = (event) => {
        const data = event.inputBuffer.getChannelData(0);
        this.chunks.push(new Float32Array(data));
        let sum = 0;
        for (let i = 0; i < data.length; i += 64) sum += data[i] * data[i];
        this.onLevel(Math.min(1, Math.sqrt(sum / (data.length / 64)) * 4));
      };
      this.source.connect(this.processor);
      this.processor.connect(this.sink);
      this.sink.connect(this.context.destination);

      this.startedAt = performance.now();
      this.state = 'recording';
      this.maxTimer = setTimeout(() => this.onAutoStop(), this.maxDurationMs);
      return true;
    })();
    return this.startPromise;
  }

  /** Stops, releases the microphone, and returns { blob, durationMs } or null when too short. */
  async stop() {
    if (this.state === 'starting') {
      try {
        const started = await this.startPromise;
        if (!started) return null;
      } catch {
        return null;
      }
    }
    if (this.state !== 'recording') return null;

    const durationMs = performance.now() - this.startedAt;
    const sampleRate = this.context.sampleRate;
    const chunks = this.chunks;
    this._release();

    if (durationMs < this.minDurationMs) return null;
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
    return { blob: encodeWav(resample(merged, sampleRate)), durationMs };
  }

  cancel() {
    this.cancelled = true;
    if (this.state === 'recording') this._release();
  }

  _release() {
    clearTimeout(this.maxTimer);
    try { this.processor && (this.processor.onaudioprocess = null); } catch {}
    try { this.source?.disconnect(); } catch {}
    try { this.processor?.disconnect(); } catch {}
    try { this.sink?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((track) => track.stop());
    this.context?.close?.().catch(() => {});
    this.state = 'idle';
    this._reset();
  }
}
