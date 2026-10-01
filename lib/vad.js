'use client';

/**
 * كاشف النشاط الصوتي + جامع الصوت (PCM 16kHz Mono)
 *
 * خفيف تمامًا: يحلّل طاقة الإشارة فقط (RMS)، بلا أي نموذج ذكاء اصطناعي.
 * يُفعَّل فقط أثناء كون التطبيق مرئيًا — يتوقف تلقائيًا عند إخفاء الصفحة
 * (visibilitychange) لتوفير البطارية واحترام الخصوصية.
 *
 * العتبة منخفضة عمدًا = حساسية عالية لسرعة الرد.
 */
export class VoiceActivityDetector {
  constructor(options = {}) {
    this.energyThreshold = options.energyThreshold ?? 0.012; // عتبة طاقة منخفضة = حساسية عالية
    this.silenceDurationMs = options.silenceDurationMs ?? 1200; // صمت 1.2ث = نهاية الجملة
    this.minSpeechMs = options.minSpeechMs ?? 250; // أدنى مدة نطق صالحة (تجاهل النقرات)
    this.onStateChange = options.onStateChange || (() => {});
    this.onUtterance = options.onUtterance || (() => {}); // Float32Array PCM

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
    this._onVisibility = null;
    this._targetSampleRate = 16000;
  }

  async start() {
    if (this.isRunning) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: this._targetSampleRate,
        },
      });

      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)({ sampleRate: this._targetSampleRate });
      // بعض المتصفحات تتجاهل sampleRate المطلوب؛ نعتمد على السياق الفعلي
      this._targetSampleRate = this.audioContext.sampleRate;

      this.source = this.audioContext.createMediaStreamSource(this.stream);

      // محلّل الطاقة لـ VAD
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
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

    if (rms > this.energyThreshold) {
      // نطق مكتشف
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechStart = now;
        this.chunks = [];
        this.onStateChange('listening-active');
      }
      this.lastVoice = now;
    } else if (this.isSpeaking) {
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
      }
    }

    this.rafId = requestAnimationFrame(() => this._loop());
  }

  _mergeChunks() {
    const total = this.chunks.reduce((s, c) => s + c.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    this.chunks = [];
    return out;
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
    this.chunks = [];
  }
}