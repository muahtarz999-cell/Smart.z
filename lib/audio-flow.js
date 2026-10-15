'use client';

/**
 * One voice turn = record -> transcribe -> ask -> speak.
 *
 *   beginTurn()  call synchronously from the tap: primes speech (iOS) and opens the mic
 *   endTurn()    stops and releases the mic, then transcribes, asks and speaks
 *   respondTo()  same pipeline for a typed message
 *
 * The microphone is always fully released before the reply is spoken, and a
 * short pause lets the phone leave "call mode"; otherwise the reply plays from
 * the earpiece at near-zero volume.
 */

import { VoiceRecorder } from './voice-recorder';
import { primeSpeech, speak, stopSpeaking } from './speech';
import { addMessage, getRecentMessages } from './conversation';

const MIC_RELEASE_SETTLE_MS = 350;
const HISTORY_TURNS = 6;

export class AudioFlowError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'AudioFlowError';
    this.code = code;
    this.cause = cause;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AudioFlowManager {
  constructor(options = {}) {
    this.getAccessToken = options.getAccessToken || (async () => null);
    this.getPreferences = options.getPreferences || (() => ({}));
    this.getContext = options.getContext || (async () => ({})); // learned profile + notes, only with consent
    this.onTurnComplete = options.onTurnComplete || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onReply = options.onReply || (() => {});
    this.onTranscript = options.onTranscript || (() => {});
    this.onError = options.onError || (() => {});
    this.state = 'ready'; // ready | preparing | listening | transcribing | thinking | speaking | error
    this.turnId = 0;
    this.destroyed = false;
    this.recorder = options.recorder || new VoiceRecorder({
      onLevel: options.onLevel,
      onAutoStop: () => { void this.endTurn(); }, // 60 s safety limit
    });
  }

  get isRecording() {
    return this.recorder.state !== 'idle';
  }

  get isBusy() {
    return this.state === 'transcribing' || this.state === 'thinking';
  }

  _setState(state) {
    if (this.destroyed || this.state === state) return;
    this.state = state;
    this.onStateChange(state);
  }

  _fail(error) {
    const normalised = error instanceof Error ? error : new AudioFlowError('UNKNOWN', 'حدث خطأ غير متوقع.');
    this._setState('error');
    this.onError(normalised);
  }

  /** Must be called synchronously inside the tap/press handler. */
  beginTurn() {
    if (this.destroyed || this.isRecording || this.isBusy) return Promise.resolve(false);
    this.turnId += 1;
    stopSpeaking();
    primeSpeech();
    this._setState('preparing');
    let started;
    try {
      started = this.recorder.start();
    } catch (error) {
      this._fail(error);
      return Promise.resolve(false);
    }
    return started.then((ok) => {
      this._setState(ok ? 'listening' : 'ready');
      return ok;
    }, (error) => {
      this._fail(error);
      return false;
    });
  }

  async endTurn() {
    if (!this.isRecording) return false;
    const turn = this.turnId;
    const recording = await this.recorder.stop(); // the microphone is released here
    if (!recording) {
      this._setState('ready');
      this.onError(new AudioFlowError('TOO_SHORT', 'التسجيل قصير جداً. اضغط، تحدث، ثم اضغط مرة أخرى للإرسال.'));
      return false;
    }
    try {
      this._setState('transcribing');
      const text = await this._transcribe(recording.blob);
      if (turn !== this.turnId) return false;
      if (!text) throw new AudioFlowError('EMPTY_TRANSCRIPT', 'لم أسمع كلاماً واضحاً. حاول مرة أخرى بصوت أوضح.');
      this.onTranscript(text);
      await this.respondTo(text, { channel: 'voice', turn });
      return true;
    } catch (error) {
      if (turn === this.turnId) this._fail(error);
      return false;
    }
  }

  cancelTurn() {
    this.turnId += 1;
    this.recorder.cancel();
    stopSpeaking();
    this._setState('ready');
  }

  stopSpeaking() {
    stopSpeaking();
    if (this.state === 'speaking') this._setState('ready');
  }

  /** Typed or transcribed text -> reply (+ speech). For typed text call primeSpeech() in the submit handler. */
  async respondTo(text, { channel = 'text', turn, speakReply = true } = {}) {
    const currentTurn = turn ?? (this.turnId += 1);
    const history = await getRecentMessages(HISTORY_TURNS).catch(() => []);
    await addMessage('user', text).catch(() => {});

    this._setState('thinking');
    const reply = await this._ask(text, history, channel);
    if (currentTurn !== this.turnId) return null;

    await addMessage('assistant', reply).catch(() => {});
    this.onReply(reply);
    try { this.onTurnComplete(); } catch {}

    if (speakReply) {
      await wait(MIC_RELEASE_SETTLE_MS);
      if (currentTurn !== this.turnId) return reply;
      this._setState('speaking');
      try {
        await speak(reply);
      } catch (error) {
        this.onError(error); // the text reply is already on screen
      }
    }
    if (currentTurn === this.turnId) this._setState('ready');
    return reply;
  }

  async _authorizedFetch(url, init) {
    const token = await this.getAccessToken();
    if (!token) throw new AudioFlowError('AUTH', 'انتهت جلسة الدخول. سجّل الدخول مرة أخرى.');
    let response;
    try {
      response = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
    } catch (error) {
      throw new AudioFlowError('NETWORK', 'لا يوجد اتصال بالإنترنت أو الخادم لا يستجيب.', error);
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) throw new AudioFlowError('AUTH', 'انتهت جلسة الدخول. سجّل الدخول مرة أخرى.');
    if (!response.ok) throw new AudioFlowError(data.code || 'SERVER', data.message || 'تعذر إكمال الطلب الآن.');
    return data;
  }

  async _transcribe(blob) {
    const form = new FormData();
    form.append('audio', blob, 'audio.wav');
    const data = await this._authorizedFetch('/api/transcribe', { method: 'POST', body: form });
    return typeof data.text === 'string' ? data.text.trim() : '';
  }

  async _ask(message, history, channel) {
    const preferences = this.getPreferences() || {};
    const context = await Promise.resolve(this.getContext()).catch(() => ({})) || {};
    const data = await this._authorizedFetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        channel,
        history: history.map(({ role, content }) => ({ role, content })),
        responseStyle: preferences.responseStyle,
        language: preferences.language,
        profile: context.profile,
        memories: context.memories,
      }),
    });
    if (typeof data.reply !== 'string' || !data.reply.trim()) {
      throw new AudioFlowError('EMPTY_REPLY', 'لم يصل رد من المساعد. أعد المحاولة.');
    }
    return data.reply.trim();
  }

  destroy() {
    this.cancelTurn();
    this.destroyed = true;
  }
}
