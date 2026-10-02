'use client';

/**
 * تنسيق تدفق الصوت الكامل:
 * Microphone → VAD → Vosk STT → Assistant API → TTS → Listening
 *
 * - يمنع تقاطع العمليات (transcription, API, TTS)
 * - يتيح مقاطعة TTS عند تأكيد كلام المستخدم
 * - يدير حالات الـ Orb اللازمة
 * - يحفظ السياق والرسائل
 */

import { VoiceActivityDetector } from './vad';
import { speak, stopSpeaking, initVoices } from './tts';
import { addMessage, getRecentMessages, getLastAssistantMessage } from './conversation';

export class AudioFlowManager {
  constructor(options = {}) {
    this.vad = null;
    this.onStateChange = options.onStateChange || (() => {});
    this.onReply = options.onReply || (() => {});
    this.getAccessToken = options.getAccessToken || (async () => null);

    // حالات التحكم
    this.isProcessing = false; // STT أو API أو TTS جارية
    this.isTTSSpeaking = false;
    this.isVADRunning = false;
    this.wasInterrupted = false;
    this.pendingUtterance = null;
  }

  /**
   * ابدأ المستمع الكامل:
   * 1. هيّئ TTS (الأصوات)
   * 2. ابدأ VAD
   */
  async start() {
    try {
      // هيّئ أصوات النطق أولاً
      initVoices();

      // أنشئ معرّف الصوت
      this.vad = new VoiceActivityDetector({
        onStateChange: this._onVADStateChange.bind(this),
        onUtterance: this._onUtterance.bind(this),
        onSpeechConfirmed: this._interruptTTS.bind(this),
      });

      const vadStarted = await this.vad.start();
      if (!vadStarted) {
        this.onStateChange('error');
        return false;
      }

      this.isVADRunning = true;
      return true;
    } catch (err) {
      console.error('[AudioFlow] Start failed:', err);
      this.onStateChange('error');
      return false;
    }
  }

  /**
   * معالج تغيير حالة VAD
   */
  _onVADStateChange(state, error) {
    if (error) {
      console.error('[AudioFlow] VAD Error:', error);
      this.onStateChange('error');
      return;
    }

    // إذا كنا نطبق TTS الآن، تجاهل تغييرات VAD (امنع تقاطع الصوت)
    if (this.isTTSSpeaking) {
      if (state !== 'listening' && state !== 'paused') {
        console.warn('[AudioFlow] Ignoring VAD state during TTS:', state);
      }
      return;
    }

    // تمرير الحالات إلى Orb (listening, listening-active, transcribing, error, paused)
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

    // منع تراكم الطلبات
    if (this.isProcessing) {
      if (interruptedUtterance) {
        this.pendingUtterance = pcmAudio;
      }
      console.warn('[AudioFlow] Already processing, ignoring new utterance');
      return;
    }

    this.isProcessing = true;
    try {
      // 1. STT: تحويل الصوت إلى نص
      this.onStateChange('transcribing');
      const text = await this._transcribe(pcmAudio);

      if (!text) {
        console.warn('[AudioFlow] Transcription returned empty text');
        this.isProcessing = false;
        this.onStateChange('listening');
        return;
      }

      console.log('[AudioFlow] Transcribed:', text);

      // حفظ رسالة المستخدم
      await addMessage('user', text);

      // 2. API: احصل على رد من المساعد
      this.onStateChange('thinking');
      const reply = await this._getAssistantReply(text);

      if (!reply) {
        console.warn('[AudioFlow] No reply from assistant');
        this.isProcessing = false;
        this.onStateChange('listening');
        return;
      }

      console.log('[AudioFlow] Got reply:', reply);

      // حفظ رد المساعد
      await addMessage('assistant', reply);

      // 3. TTS: انطق الرد
      this.onStateChange('speaking');
      await this._speak(reply);

      // العودة للاستماع
      this.onStateChange('listening');
      this.onReply(reply);
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
   * تحويل الصوت إلى نص باستخدام Groq Whisper API
   */
  async _transcribe(pcmAudio) {
    try {
      // حول Float32Array إلى WAV Buffer
      const wavBuffer = this._audioToWav(pcmAudio);

      // أنشئ FormData مع الصوت
      const formData = new FormData();
      formData.append('audio', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
      const accessToken = await this.getAccessToken();
      if (!accessToken) return null;

      // أرسل إلى الـ API الخاص بنا
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
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
   * حول Float32Array PCM إلى WAV
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

    // RIFF header
    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    writeString(8, 'WAVE');

    // fmt sub-chunk
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bits, true);

    // data sub-chunk
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    // كتابة بيانات الصوت
    let offset = 44;
    for (let i = 0; i < pcmData.length; i++) {
      const s = Math.max(-1, Math.min(1, pcmData[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }

    return new Uint8Array(buffer);
  }

  /**
   * احصل على رد من المساعد عبر API
   */
  async _getAssistantReply(userMessage) {
    try {
      // احصل على آخر رسائل كسياق
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
  * نطق النص باستخدام TTS مع إبقاء VAD في وضع مراقبة المقاطعة
   */
  async _speak(text) {
    try {
      this.isTTSSpeaking = true;
      this.vad?.setInterruptMode(true);

      await speak(text);
    } catch (err) {
      console.error('[AudioFlow] TTS failed:', err);
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
   * أوقف الاستماع والمعالجة
   */
  stop() {
    this.isProcessing = false;
    this.isTTSSpeaking = false;

    stopSpeaking();

    if (this.vad) {
      this.vad.stop();
      this.vad = null;
    }

    this.isVADRunning = false;
    this.onStateChange('paused');
  }

  /**
   * استأنف الاستماع
   */
  resume() {
    if (this.vad && this.isVADRunning) {
      this.vad.resume();
      this.onStateChange('listening');
    }
  }

  /**
   * أوقف النطق الحالي
   */
  stopSpeaking() {
    stopSpeaking();
    this.isTTSSpeaking = false;
  }
}
