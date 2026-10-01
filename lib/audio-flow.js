'use client';

/**
 * تنسيق تدفق الصوت الكامل:
 * Microphone → VAD → Vosk STT → Assistant API → TTS → Listening
 *
 * - يمنع تقاطع العمليات (transcription, API, TTS)
 * - يمنع التقاط VAD للصوت أثناء TTS
 * - يدير حالات الـ Orb اللازمة
 * - يحفظ السياق والرسائل
 */

import { VoiceActivityDetector } from './vad';
import { createStreamRecognizer } from './stt-vosk';
import { speak, stopSpeaking, isSpeakingNow, initVoices } from './tts';
import { addMessage, getRecentMessages, getLastAssistantMessage } from './conversation';

export class AudioFlowManager {
  constructor(options = {}) {
    this.vad = null;
    this.streamRecognizer = null;
    this.onStateChange = options.onStateChange || (() => {});
    this.onReply = options.onReply || (() => {});

    // حالات التحكم
    this.isProcessing = false; // STT أو API أو TTS جارية
    this.isTTSSpeaking = false;
    this.isVADRunning = false;
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
    // منع تراكم الطلبات
    if (this.isProcessing) {
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
    }
  }

  /**
   * تحويل الصوت إلى نص باستخدام Vosk
   */
  async _transcribe(pcmAudio) {
    try {
      if (!this.streamRecognizer) {
        this.streamRecognizer = await createStreamRecognizer();
      }

      // غذّ الصوت للمعرّف
      this.streamRecognizer.feed(pcmAudio);

      // احصل على النص النهائي
      const text = this.streamRecognizer.finalText();
      return text;
    } catch (err) {
      console.error('[AudioFlow] Transcription failed:', err);
      return null;
    }
  }

  /**
   * احصل على رد من المساعد عبر API
   */
  async _getAssistantReply(userMessage) {
    try {
      // احصل على آخر رسائل كسياق
      const recentMessages = await getRecentMessages(5);

      const response = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
   * نطق النص باستخدام TTS
   * منع VAD من الالتقاط أثناء النطق
   */
  async _speak(text) {
    try {
      this.isTTSSpeaking = true;

      // انطق النص
      await speak(text);

      // صغّر VAD أثناء النطق (إيقاف مؤقت)
      if (this.vad) {
        this.vad.pause();
      }

      // انتظر انتهاء النطق
      while (isSpeakingNow()) {
        await new Promise((r) => setTimeout(r, 100));
      }

      // استأنف VAD بعد النطق
      if (this.vad) {
        this.vad.resume();
      }
    } catch (err) {
      console.error('[AudioFlow] TTS failed:', err);
    } finally {
      this.isTTSSpeaking = false;
    }
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
