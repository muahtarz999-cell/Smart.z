'use client';

/**
 * Hands-free listening for driving mode inside the app: waits for speech,
 * records one sentence, and returns it as a 16 kHz WAV.
 *
 * Half duplex on purpose: the microphone is opened for listen() and fully
 * released before it returns, so the reply is spoken with the microphone
 * closed (loud, from the media speaker or the car, and the assistant never
 * hears itself). One AudioContext lives for the whole driving session; it is
 * created in the tap that started the session so the browser lets it run.
 */

import { encodeWav, isRecordingSupported, microphoneError, resample, VoiceRecorderError } from './voice-recorder';
import { createSpeechDetector, SPEECH_DETECTOR_DEFAULTS } from './speech-detector';

const BUFFER_SIZE = 2048;
const PRE_ROLL_MS = 300;

export class HandsFreeRecorder {
  constructor({ onLevel } = {}) {
    this.onLevel = onLevel || (() => {});
    this.context = null;
    this.active = null; // { release }
  }

  /** Call from a tap when possible (creates/resumes the shared AudioContext). */
  prepare() {
    if (!isRecordingSupported()) throw new VoiceRecorderError('UNSUPPORTED', 'التسجيل الصوتي غير مدعوم هنا.');
    if (!this.context || this.context.state === 'closed') {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContextClass();
    }
    return this.context.resume?.().catch(() => {});
  }

  get isListening() {
    return Boolean(this.active);
  }

  /**
   * Resolves with { blob, durationMs } for one sentence, or null when stopped.
   * Rejects with a VoiceRecorderError when the microphone cannot be opened.
   */
  async listen({ signal, onSpeechStart } = {}) {
    if (this.active) throw new VoiceRecorderError('BUSY', 'الاستماع يعمل بالفعل.');
    await this.prepare();
    if (signal?.aborted) return null;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (error) {
      throw microphoneError(error);
    }
    if (signal?.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      return null;
    }

    const context = this.context;
    const sampleRate = context.sampleRate;
    const frameMs = (BUFFER_SIZE / sampleRate) * 1000;
    const detector = createSpeechDetector({ frameMs });
    const preRollFrames = Math.ceil((PRE_ROLL_MS + SPEECH_DETECTOR_DEFAULTS.startMs) / frameMs);
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1);
    const sink = context.createGain();
    sink.gain.value = 0;

    return new Promise((resolve) => {
      let ring = [];
      let chunks = null;
      let startedAt = 0;
      let done = false;

      const release = (result) => {
        if (done) return;
        done = true;
        processor.onaudioprocess = null;
        try { source.disconnect(); } catch {}
        try { processor.disconnect(); } catch {}
        try { sink.disconnect(); } catch {}
        stream.getTracks().forEach((track) => track.stop());
        signal?.removeEventListener('abort', onAbort);
        this.active = null;
        this.onLevel(0);
        resolve(result);
      };
      const onAbort = () => release(null);
      signal?.addEventListener('abort', onAbort);
      this.active = { release };

      processor.onaudioprocess = (event) => {
        if (done) return;
        const data = new Float32Array(event.inputBuffer.getChannelData(0));
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        this.onLevel(Math.min(1, rms * 6));

        if (chunks) chunks.push(data);
        else {
          ring.push(data);
          if (ring.length > preRollFrames) ring.shift();
        }

        const result = detector.push(rms);
        if (result === 'start') {
          chunks = ring;
          ring = [];
          startedAt = performance.now();
          try { onSpeechStart?.(); } catch {}
        } else if (result === 'discard') {
          chunks = null; // a bump or a cough: keep waiting
        } else if (result === 'end' || result === 'max') {
          const recorded = chunks;
          const durationMs = performance.now() - startedAt;
          const total = recorded.reduce((n, chunk) => n + chunk.length, 0);
          const merged = new Float32Array(total);
          let offset = 0;
          for (const chunk of recorded) { merged.set(chunk, offset); offset += chunk.length; }
          release({ blob: encodeWav(resample(merged, sampleRate)), durationMs });
        }
      };

      source.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);
    });
  }

  /** Stops listening (listen() resolves null). */
  stop() {
    this.active?.release(null);
  }

  close() {
    this.stop();
    this.context?.close?.().catch(() => {});
    this.context = null;
  }
}
