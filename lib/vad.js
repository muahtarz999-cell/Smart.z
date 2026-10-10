'use client';

/**
 * كاشف النشاط الصوتي + جامع الصوت (PCM 16kHz Mono)
 *
 * يحلّل طاقة الإشارة، ويستخدم الارتباط الذاتي لتمييز الإطارات الصوتية المجهورة أثناء مقاطعة TTS.
 * يُفعَّل فقط أثناء كون التطبيق مرئيًا — يتوقف تلقائيًا عند إخفاء الصفحة
 * (visibilitychange) لتوفير البطارية واحترام الخصوصية.
 *
 * العتبة منخفضة عمدًا = حساسية عالية لسرعة الرد.
 */
export class VoiceActivityDetector {
  constructor(options = {}) {
    this.energyThreshold = options.energyThreshold ?? 0.012; // عتبة طاقة منخفضة = حساسية عالية
    this.interruptThreshold = options.interruptThreshold ?? 0.055;
    this.interruptSpeechMs = options.interruptSpeechMs ?? 650;
    this.interruptMinVoicedRatio = options.interruptMinVoicedRatio ?? 0.55;
    this.interruptGapMs = options.interruptGapMs ?? 180;
    this.silenceDurationMs = options.silenceDurationMs ?? 1200; // صمت 1.2ث = نهاية الجملة
    this.minSpeechMs = options.minSpeechMs ?? 250; // أدنى مدة نطق صالحة (تجاهل النقرات)
    this.onStateChange = options.onStateChange || (() => {});
    this.onUtterance = options.onUtterance || (() => {}); // Float32Array PCM
    this.onSpeechConfirmed = options.onSpeechConfirmed || (() => {});

    this.audioContext = null;
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.processor = null;
    this.isRunning = false;
    this.isSpeaking = false;
    this.rafId = null;
    this.speechStart = 0;
    this.lastVoice = 0;
    this.chunks = [];
    this.interruptMode = false;
    this.speechConfirmed = false;
    this.interruptVoicedMs = 0;
    this.interruptObservedMs = 0;
    this.lastFrameTime = null;
    this._onVisibility = null;
    this._targetSampleRate = 16000;
    this._outputSampleRate = 16000;
  }

  async start() {
    if (this.isRunning) return true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone access is unavailable in this browser or connection.');
      }

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });

      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) {
        throw new Error('Audio processing is unavailable in this browser.');
      }

      this.audioContext = new AudioContext();
      this._targetSampleRate = this.audioContext.sampleRate;

      this.source = this.audioContext.createMediaStreamSource(this.stream);

      // محلّل الطاقة لـ VAD
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.5;

      // جامع PCM خام — ScriptProcessorNode متوافق مع كل المتصفحات
      // (للأداء الأمثل مستقبلاً يمكن الانتقال إلى AudioWorklet)
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.processor.onaudioprocess = (e) => {
        if (this.isSpeaking) {
          const data = e.inputBuffer.getChannelData(0);
          this.chunks.push(new Float32Array(data));
        }
      };

      this.source.connect(this.analyser);
      this.analyser.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this.isRunning = true;
      this._loop();

      // إيقاف تلقائي عند إخفاء الصفحة
      this._onVisibility = () => {
        if (document.hidden) this.pause();
        else this.resume();
      };
      document.addEventListener('visibilitychange', this._onVisibility);

      this.onStateChange('listening');
      return true;
    } catch (err) {
      console.error('[VAD] فشل بدء الميكروفون:', err);
      this.stop();
      this.onStateChange('error', err);
      return false;
    }
  }

  _loop() {
    if (!this.isRunning) return;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);

    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();
    const frameDuration = this.lastFrameTime === null
      ? 0
      : Math.min(now - this.lastFrameTime, 50);
    this.lastFrameTime = now;

    const activeThreshold = this.interruptMode
      ? this.interruptThreshold
      : this.energyThreshold;
    const voicedFrame =
      !this.interruptMode ||
      (rms > activeThreshold && this._isVoicedFrame(buf));

    if (rms > activeThreshold && voicedFrame) {
      // نطق مكتشف
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechStart = now;
        this.chunks = [];
        this.speechConfirmed = false;
        this.interruptVoicedMs = 0;
        this.interruptObservedMs = 0;
        this.onStateChange('listening-active');
      }
      this.lastVoice = now;
      if (this.interruptMode && !this.speechConfirmed) {
        this.interruptVoicedMs += frameDuration;
        this.interruptObservedMs += frameDuration;
        if (
          now - this.speechStart >= this.interruptSpeechMs &&
          this.interruptVoicedMs / Math.max(this.interruptObservedMs, 1) >=
            this.interruptMinVoicedRatio
        ) {
          this.speechConfirmed = true;
          this.onSpeechConfirmed();
        }
      }
    } else if (this.isSpeaking) {
      if (this.interruptMode && !this.speechConfirmed) {
        this.interruptObservedMs += frameDuration;
        if (now - this.lastVoice > this.interruptGapMs) {
          this.isSpeaking = false;
          this.speechConfirmed = false;
          this.interruptVoicedMs = 0;
          this.interruptObservedMs = 0;
          this.chunks = [];
          this.onStateChange('listening');
          this.rafId = requestAnimationFrame(() => this._loop());
          return;
        }
      }

      // في صمت — تحقق من نهاية الجملة
      if (now - this.lastVoice > this.silenceDurationMs) {
        const dur = this.lastVoice - this.speechStart;
        this.isSpeaking = false;
        if (dur >= this.minSpeechMs) {
          const audio = this._mergeChunks();
          this.onStateChange('transcribing');
          this.onUtterance(audio);
        } else {
          this.chunks = [];
          this.onStateChange('listening');
        }
        this.speechConfirmed = false;
        this.interruptVoicedMs = 0;
        this.interruptObservedMs = 0;
      }
    }

    this.rafId = requestAnimationFrame(() => this._loop());
  }

  _mergeChunks() {
    const total = this.chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) {
      merged.set(c, off);
      off += c.length;
    }
    this.chunks = [];

    if (!this._targetSampleRate || this._targetSampleRate === this._outputSampleRate) {
      return merged;
    }

    const outputLength = Math.round(
      merged.length * this._outputSampleRate / this._targetSampleRate
    );
    const resampled = new Float32Array(outputLength);
    const sampleRatio = this._targetSampleRate / this._outputSampleRate;
    for (let i = 0; i < outputLength; i++) {
      const sourcePosition = i * sampleRatio;
      const sourceIndex = Math.floor(sourcePosition);
      const fraction = sourcePosition - sourceIndex;
      const nextIndex = Math.min(sourceIndex + 1, merged.length - 1);
      resampled[i] =
        merged[sourceIndex] * (1 - fraction) + merged[nextIndex] * fraction;
    }
    return resampled;
  }

  _isVoicedFrame(buffer) {
    const sampleStep = Math.max(1, Math.round(this._targetSampleRate / 16000));
    const sampleCount = Math.floor(buffer.length / sampleStep);
    const minLag = Math.max(2, Math.floor(16000 / 350));
    const maxLag = Math.min(Math.floor(16000 / 80), Math.floor(sampleCount / 2));
    if (maxLag <= minLag) return false;

    let mean = 0;
    for (let i = 0, sourceIndex = 0; i < sampleCount; i++, sourceIndex += sampleStep) {
      mean += buffer[sourceIndex];
    }
    mean /= sampleCount;

    let bestCorrelation = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let cross = 0;
      let energyA = 0;
      let energyB = 0;
      for (let i = 0; i < sampleCount - lag; i++) {
        const a = buffer[i * sampleStep] - mean;
        const b = buffer[(i + lag) * sampleStep] - mean;
        cross += a * b;
        energyA += a * a;
        energyB += b * b;
      }
      const correlation = cross / Math.sqrt(energyA * energyB || 1);
      bestCorrelation = Math.max(bestCorrelation, correlation);
    }

    return bestCorrelation >= 0.55;
  }

  setInterruptMode(enabled) {
    if (this.interruptMode === enabled) return;
    this.interruptMode = enabled;
    if (enabled || (this.isSpeaking && !this.speechConfirmed)) {
      this.isSpeaking = false;
      this.speechConfirmed = false;
      this.interruptVoicedMs = 0;
      this.interruptObservedMs = 0;
      this.chunks = [];
    }
  }

  pause() {
    if (this.stream) this.stream.getTracks().forEach((t) => (t.enabled = false));
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.onStateChange('paused');
  }

  resume() {
    if (!this.isRunning) return;
    if (this.stream) this.stream.getTracks().forEach((t) => (t.enabled = true));
    this._loop();
    this.onStateChange('listening');
  }

  stop() {
    this.isRunning = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this._onVisibility) {
      document.removeEventListener('visibilitychange', this._onVisibility);
      this._onVisibility = null;
    }
    try {
      this.processor?.disconnect();
      this.analyser?.disconnect();
      this.source?.disconnect();
    } catch (e) {
      // تجاهل
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.isSpeaking = false;
    this.speechConfirmed = false;
    this.interruptVoicedMs = 0;
    this.interruptObservedMs = 0;
    this.lastFrameTime = null;
    this.chunks = [];
  }
}