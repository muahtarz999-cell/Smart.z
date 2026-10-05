class AudioManager {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
  }

  async isAudioBlocked() {
    this.init();
    if (!this.ctx) return true;
    return this.ctx.state === 'suspended';
  }

  async unlockAudio() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    if (this.ctx) {
      // تشغيل صوت صامت لفك الحظر تماماً على iOS Safari
      const buffer = this.ctx.createBuffer(1, 1, 22050);
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.ctx.destination);
      source.start(0);
      return this.ctx.state === 'running';
    }
    return false;
  }
}

export const audioManager = new AudioManager();

