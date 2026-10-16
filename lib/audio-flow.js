'use client';

/**
 * مدير الصوت مع نمط "اضغط للتحدث" (Push-to-Talk)
 * 
 * - الميكروفون مغلق افتراضياً
 * - عند الضغط على الزر: تفعيل الاستماع
 * - عند رفع الضغط: إيقاف الاستماع والمعالجة
 * - تحرير كامل للميكروفون عند عدم الاستخدام
 */

import { VoiceActivityDetector } from './vad';
import { speak, stopSpeaking } from './tts';
import { addMessage, getRecentMessages } from './conversation';
import { resolveVoiceTrigger } from './voice-trigger';

export class AudioFlowManager {
  constructor(options = {}) {
    this.vad = null;
    this.onStateChange = options.onStateChange || (() => {});
    this.onReply = options.onReply || (() => {});
    this.onAudioError = options.onAudioError || (() => {});
    this.getAccessToken = options.getAccessToken || (async () => null);

    // حالات التحكم
    this.isProcessing = false;
    this.isTTSSpeaking = false;
    this.isListening = false; // يُفعّل فقط عند الضغط على الزر
    this.isStarting = false;
    this.stopRequested = false;
    this.wasInterrupted = false;
    this.pendingUtterance = null;
    this.isInitialized = false;
  }

  get isVADRunning() {
    return this.isListening && Boolean(this.vad?.isRunning);
  }

  /**
   * تهيئة المدير (طلب الإذن فقط - الميكروفون مغلق)
   * استدعِ هذا عند تحميل التطبيق
   */
  async initialize() {
    if (this.isInitialized) return true;
    
    try {
      // تحقق من توفر الميكروفون
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('الميكروفون غير متاح في هذا الجهاز.');
      }

      // اطلب الإذن فقط (لا تفتح الميكروفون بعد)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });

      // أغلق البث فوراً (لم نحتجه الآن)
      stream.getTracks().forEach(track => track.stop());

      this.isInitialized = true;
      this.onStateChange('ready');
      return true;
    } catch (err) {
      console.error('[AudioFlow] Initialization failed:', err);
      this.onAudioError(err);
      this.onStateChange('error');
      return false;
    }
  }

  /**
   * ابدأ الاستماع عند الضغط على الزر
   */
  async startListening() {
    if (this.isListening || this.isStarting || this.isProcessing) return false;

    this.isStarting = true;
    this.stopRequested = false;
    try {
      if (!this.isInitialized) {
        const initialized = await this.initialize();
        if (!initialized || this.stopRequested) return false;
      }

      // أنشئ معرّف الصوت الآن (عند الضغط على الزر فقط)
      const vad = new VoiceActivityDetector({
        onStateChange: this._onVADStateChange.bind(this),
        onUtterance: this._onUtterance.bind(this),
        onSpeechConfirmed: this._interruptTTS.bind(this),
      });
      this.vad = vad;

      const vadStarted = await vad.start();
      if (!vadStarted) {
        if (this.vad === vad) this.vad = null;
        this.onStateChange('error');
        return false;
      }

      if (this.stopRequested || this.vad !== vad) {
        vad.stop();
        if (this.vad === vad) this.vad = null;
        this.onStateChange('ready');
        return false;
      }

      this.isListening = true;
      this.onStateChange('listening');
      return true;
    } catch (err) {
      console.error('[AudioFlow] Start listening failed:', err);
      this.onAudioError(err);
      this.onStateChange('error');
      return false;
    } finally {
      this.isStarting = false;
    }
  }

  start() {
    return this.startListening();
  }

  /**
   * أوقف الاستماع عند رفع الضغط
   */
  stopListening() {
    if (this.isStarting) {
      this.stopRequested = true;
      this.vad?.stop();
      this.vad = null;
      return;
    }
    if (!this.isListening) return;

    // إذا كان هناك تسجيل جاري، أوقفه فوراً
    if (this.vad && this.vad.isSpeaking) {
      // أرسل البيانات المتجمعة للمعالجة
      const audio = this.vad._mergeChunks();
      this.vad.stop();
      this.vad = null;
      this.isListening = false;

      if (audio && audio.length > 0) {
        this.onStateChange('transcribing');
        this._onUtterance(audio);
      } else {
        this.onStateChange('ready');
      }
    } else {
      // لم يكن هناك كلام - أوقف فقط
      if (this.vad) {
        this.vad.stop();
        this.vad = null;
      }
      this.isListening = false;
      this.onStateChange('ready');
    }
  }

  /**
   * معالج تغيير حالة VAD
   */
  _onVADStateChange(state, error) {
    if (error) {
      console.error('[AudioFlow] VAD Error:', error);
      this.onAudioError(error);
      this.onStateChange('error');
      return;
    }

    if (this.isTTSSpeaking) {
      if (state !== 'listening' && state !== 'paused') {
        console.warn('[AudioFlow] Ignoring VAD state during TTS:', state);
      }
      return;
    }

    if (state === 'listening-active') {
      this.onStateChange('listening-active');
    } else if (state === 'transcribing') {
      this.onStateChange('transcribing');
    } else if (state === 'listening') {
      if (!this.isProcessing) {
        this.onStateChange('listening');
      }
    } else if (state === 'paused') {
      this.onStateChange('paused');
    } else if (state === 'error') {
      this.onStateChange('error');
    }
  }

  /**
   * معالج الكلام المكتشف من VAD
   */
  async _onUtterance(pcmAudio) {
    const interruptedUtterance = this.wasInterrupted;
    if (interruptedUtterance) {
      this.wasInterrupted = false;
      this.vad?.setInterruptMode(false);
    }

    if (this.isProcessing) {
      if (interruptedUtterance) {
        this.pendingUtterance = pcmAudio;
      }
      console.warn('[AudioFlow] Already processing, ignoring new utterance');
      return;
    }

    this.isProcessing = true;
    try {
      this.onStateChange('transcribing');
      const text = await this._transcribe(pcmAudio);

      if (!text) {
        console.warn('[AudioFlow] Transcription returned empty text');
        this.isProcessing = false;
        this.onStateChange('listening');
        return;
      }

      const trigger = resolveVoiceTrigger(text);
      console.log('[AudioFlow] Transcribed:', text);
      await addMessage('user', text);

      if (trigger.triggered && !trigger.text) {
        const clarification = 'نعم، كيف أستطيع مساعدتك؟';
        await addMessage('assistant', clarification);
        this.onReply(clarification);
        this.onStateChange('speaking');
        await this._speak(clarification);
        this.onStateChange('ready');
        return;
      }

      this.onStateChange('thinking');
      const reply = await this._getAssistantReply(trigger.text || text);

      if (!reply) {
        console.warn('[AudioFlow] No reply from assistant');
        this.isProcessing = false;
        this.onStateChange('listening');
        return;
      }

      console.log('[AudioFlow] Got reply:', reply);
      await addMessage('assistant', reply);
      this.onReply(reply);

      this.onStateChange('speaking');
      await this._speak(reply);

      this.onStateChange('ready');
    } catch (err) {
      console.error('[AudioFlow] Utterance processing failed:', err);
      this.onStateChange('error');
    } finally {
      this.isProcessing = false;
      if (this.pendingUtterance) {
        const pendingUtterance = this.pendingUtterance;
        this.pendingUtterance = null;
        this._onUtterance(pendingUtterance);
      }
    }
  }

  /**
   * تحويل الصوت إلى نص
   */
  async _transcribe(pcmAudio) {
    try {
      const wavBuffer = this._audioToWav(pcmAudio);
      const formData = new FormData();
      formData.append('audio', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
      const accessToken = await this.getAccessToken();
      if (!accessToken) return null;

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const err = await response.json();
        console.error('[AudioFlow] Transcribe API error:', err);
        return null;
      }

      const data = await response.json();
      return data.text || null;
    } catch (err) {
      console.error('[AudioFlow] Transcription failed:', err);
      return null;
    }
  }

  /**
   * تحويل PCM إلى WAV
   */
  _audioToWav(pcmData) {
    const sampleRate = 16000;
    const channels = 1;
    const bits = 16;

    const bytesPerSample = bits / 8;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = pcmData.length * bytesPerSample;

    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);

    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    writeString(8, 'WAVE');

    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bits, true);

    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < pcmData.length; i++) {
      const s = Math.max(-1, Math.min(1, pcmData[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }

    return new Uint8Array(buffer);
  }

  /**
   * احصل على رد من المساعد
   */
  async _getAssistantReply(userMessage) {
    try {
      const recentMessages = await getRecentMessages(5);
      const accessToken = await this.getAccessToken();
      if (!accessToken) return null;

      const response = await fetch('/api/assistant', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: userMessage }),
      });

      if (!response.ok) {
        const err = await response.text();
        console.error('[AudioFlow] Assistant API error:', err);
        return null;
      }

      const data = await response.json();
      return data.reply || null;
    } catch (err) {
      console.error('[AudioFlow] API call failed:', err);
      return null;
    }
  }

  /**
   * نطق الرد
   */
  async _speak(text) {
    try {
      this.isTTSSpeaking = true;
      this.vad?.setInterruptMode(true);

      const played = await speak(text);
      if (!played && !this.wasInterrupted && this.isListening) {
        const error = new Error('تعذر نطق الرد بالصوت العربي المحلي.');
        error.name = 'SpeechSynthesisError';
        throw error;
      }
    } catch (err) {
      console.error('[AudioFlow] TTS failed:', err);
      this.onAudioError(err);
    } finally {
      if (!this.wasInterrupted) this.vad?.setInterruptMode(false);
      this.isTTSSpeaking = false;
    }
  }

  _interruptTTS() {
    if (!this.isTTSSpeaking) return;
    this.wasInterrupted = true;
    this.isTTSSpeaking = false;
    stopSpeaking();
  }

  /**
   * تحرير كامل للموارد
   */
  destroy() {
    this.stopListening();
    stopSpeaking();
    this.isInitialized = false;
  }

  stop() {
    this.destroy();
  }
}
