'use client';

/**
 * Driving mode: the conversation stays open without pressing anything.
 *
 *   "وضع القيادة"          → starts (only when allowed in settings)
 *   "وضع القيادة انتهى"    → stops (also "أنهِ وضع القيادة", "وصلت", the notification button)
 *   10 minutes of silence  → stops by itself
 *
 * Two engines:
 *   native (Android app)   a foreground service listens and speaks, also
 *                          while Maps or another app is in front, with a
 *                          floating bubble. See android/.../driving/.
 *   web (iPhone, browser)  the same loop inside the page; works while the app
 *                          is on screen, and the screen is kept awake.
 *
 * Half duplex in both: the microphone is closed while the assistant speaks,
 * so it never answers itself. A tap (or the bubble, or the steering-wheel
 * media button on Android) stops the assistant talking.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';
import { HandsFreeRecorder } from './hands-free-recorder';
import { DRIVING_MESSAGES } from './driving-commands';
import { speak, stopSpeaking, whenSpeechDone } from './speech';
import { getDeviceId } from './device-lock';

const SETTINGS_KEY = 'smartz-driving-v1';
const DEFAULTS = Object.freeze({ enabled: false, idleMinutes: 10, bubble: true });
const RETRY_DELAY_MS = 2500;

let plugin = null;
function nativePlugin() {
  if (!plugin) plugin = registerPlugin('DrivingMode');
  return plugin;
}

export function getDrivingSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const idle = Number(stored.idleMinutes);
    return {
      enabled: stored.enabled === true,
      idleMinutes: [5, 10, 20, 30].includes(idle) ? idle : DEFAULTS.idleMinutes,
      bubble: stored.bubble !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveDrivingSettings(changes) {
  const next = { ...getDrivingSettings(), ...changes };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
  return next;
}

/** True inside the Android app built with the driving-mode service. */
export function isNativeDrivingAvailable() {
  try {
    return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('DrivingMode');
  } catch {
    return false;
  }
}

/** Android: can the bubble be drawn over other apps? */
export async function getOverlayPermission() {
  if (!isNativeDrivingAvailable()) return 'unsupported';
  try {
    const { granted } = await nativePlugin().checkOverlayPermission();
    return granted ? 'granted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

/** Opens Android's "Display over other apps" screen for Smart.z. */
export async function requestOverlayPermission() {
  if (!isNativeDrivingAvailable()) return false;
  try {
    const { granted } = await nativePlugin().requestOverlayPermission();
    return Boolean(granted);
  } catch {
    return false;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DrivingController {
  /**
   * options:
   *   audioFlow          AudioFlowManager (web engine)
   *   getNativeContext   async () => ({ baseUrl, accessToken, expiresAt, history, profile, memories, preferences, voice, undoSeconds, confirmEverySend })
   *   getAccessSession   async () => ({ accessToken, expiresAt })
   *   onChange           ({ active, engine, phase, message? }) => void
   *   onLevel            (0..1) => void
   *   onNativeTurn       ({ transcript, reply }) => void   turns spoken by the Android service
   *   onNativeAction     (action) => void                  sends the service left for the app (bulk, documents)
   */
  constructor(options = {}) {
    this.options = options;
    this.active = false;
    this.engine = null;
    this.phase = 'idle';
    this.session = 0;
    this.recorder = new HandsFreeRecorder({ onLevel: options.onLevel });
    this.listenAbort = null;
    this.wakeLock = null;
    this.nativeListeners = [];
    this.onVisibility = () => {
      if (!this.active || this.engine !== 'web') return;
      if (document.visibilityState === 'visible') void this._keepScreenOn();
      else this.recorder.stop(); // the page cannot listen in the background; the loop waits for it to come back
    };
  }

  _emit(changes = {}) {
    if (changes.phase) this.phase = changes.phase;
    try {
      this.options.onChange?.({ active: this.active, engine: this.engine, phase: this.phase, ...changes });
    } catch {}
  }

  /**
   * Call synchronously from a tap or right after a voice turn: the web engine
   * needs a recent user gesture to keep its audio running.
   */
  async start() {
    if (this.active) return true;
    if (!getDrivingSettings().enabled) {
      await this._say(DRIVING_MESSAGES.disabled);
      return false;
    }
    this.active = true;
    const session = (this.session += 1);

    if (isNativeDrivingAvailable()) {
      try {
        await this._startNative();
        return true;
      } catch (error) {
        this._removeNativeListeners();
        console.warn('[Driving] native service unavailable, using the in-app loop', error?.message);
      }
    }

    this.engine = 'web';
    try {
      this.recorder.prepare();
    } catch (error) {
      this.active = false;
      this._emit({ phase: 'idle', message: error?.message });
      return false;
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    void this._keepScreenOn();
    this._emit({ phase: 'speaking' });
    await this._say(DRIVING_MESSAGES.started);
    void this._webLoop(session);
    return true;
  }

  /** reason: 'user' | 'idle' | 'error' | 'service'. */
  async stop(reason = 'user', { announce = true } = {}) {
    if (!this.active) return;
    this.active = false;
    this.session += 1;
    const engine = this.engine;
    this.listenAbort?.abort();
    this.recorder.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this._releaseScreen();

    if (engine === 'native') {
      try { await nativePlugin().stop({ reason, announce }); } catch {}
      this._removeNativeListeners();
    }
    this.engine = null;
    this._emit({ phase: 'idle' });
    if (announce && engine !== 'native') {
      await this._say(reason === 'idle' ? DRIVING_MESSAGES.idle : DRIVING_MESSAGES.stopped);
    }
  }

  /** A tap anywhere during driving mode: stop the assistant talking and listen again. */
  interrupt() {
    if (!this.active) return;
    if (this.engine === 'native') {
      void nativePlugin().interrupt().catch(() => {});
      return;
    }
    stopSpeaking();
    this.options.audioFlow?.stopSpeaking();
  }

  /** New access token after Supabase refreshed the session. */
  async updateSession(session) {
    if (this.engine !== 'native' || !session?.accessToken) return;
    try { await nativePlugin().updateSession(session); } catch {}
  }

  destroy() {
    void this.stop('user', { announce: false });
    this.recorder.close();
  }

  // ---------------------------------------------------------------- web engine

  async _say(text) {
    try { await speak(text); } catch {}
  }

  async _keepScreenOn() {
    try {
      if (!this.wakeLock && navigator.wakeLock?.request) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener?.('release', () => { this.wakeLock = null; });
      }
    } catch {
      this.wakeLock = null; // not supported or refused; driving mode still works
    }
  }

  _releaseScreen() {
    try { this.wakeLock?.release(); } catch {}
    this.wakeLock = null;
  }

  async _webLoop(session) {
    const audioFlow = this.options.audioFlow;
    const idleMs = getDrivingSettings().idleMinutes * 60_000;
    let lastActivity = Date.now();

    while (this.active && session === this.session) {
      if (document.visibilityState === 'hidden') {
        // Inside the browser or on iPhone the microphone is not available in the background.
        this._emit({ phase: 'paused' });
        await new Promise((resolve) => {
          const back = () => {
            if (document.visibilityState === 'visible' || !this.active) {
              document.removeEventListener('visibilitychange', back);
              resolve();
            }
          };
          document.addEventListener('visibilitychange', back);
        });
        lastActivity = Date.now();
        continue;
      }

      const remaining = idleMs - (Date.now() - lastActivity);
      if (remaining <= 0) {
        await this.stop('idle');
        return;
      }

      this.listenAbort = new AbortController();
      const idleTimer = setTimeout(() => this.listenAbort?.abort(), remaining);
      this._emit({ phase: 'listening' });
      let recording = null;
      try {
        recording = await this.recorder.listen({
          signal: this.listenAbort.signal,
          onSpeechStart: () => { lastActivity = Date.now(); clearTimeout(idleTimer); },
        });
      } catch (error) {
        clearTimeout(idleTimer);
        this._emit({ phase: 'idle', message: error?.message });
        await this.stop('error', { announce: false });
        await this._say(error?.message || 'تعذر تشغيل الميكروفون، فأوقفت وضع القيادة.');
        return;
      }
      clearTimeout(idleTimer);
      if (!this.active || session !== this.session) return;
      if (!recording) continue; // idle timeout → checked at the top of the loop

      lastActivity = Date.now();
      this._emit({ phase: 'thinking' });
      const result = await audioFlow.respondToRecording(recording.blob, { channel: 'driving', ignoreNoise: true });
      await whenSpeechDone(); // a locally handled phrase (quiz answer, "تراجع") may still be speaking
      lastActivity = Date.now();
      if (result.status === 'failed' && this.active) {
        await this._say(result.error?.message || 'تعذر الاتصال. سأحاول مع جملتك التالية.');
        await wait(RETRY_DELAY_MS);
      }
    }
  }

  // ---------------------------------------------------------------- native engine (Android)

  /** The page was reloaded while the Android service kept running: reconnect to it. */
  async attachToRunningService() {
    if (!isNativeDrivingAvailable() || this.active) return false;
    try {
      const { active } = await nativePlugin().status();
      if (!active) return false;
      this.active = true;
      this.session += 1;
      await this._attachNativeListeners();
      this.engine = 'native';
      this._emit({ phase: 'listening' });
      return true;
    } catch {
      return false;
    }
  }

  async _startNative() {
    const p = nativePlugin();
    const context = await this.options.getNativeContext();
    await this._attachNativeListeners();

    const settings = getDrivingSettings();
    await p.start({
      ...context,
      deviceId: getDeviceId(), // the native service calls the API itself; the one-device lock needs this
      idleMinutes: settings.idleMinutes,
      bubble: settings.bubble,
      startMessage: DRIVING_MESSAGES.started,
    });
    this.engine = 'native';
    this._emit({ phase: 'listening' });
  }

  async _attachNativeListeners() {
    const p = nativePlugin();
    this._removeNativeListeners();
    const add = async (event, handler) => {
      this.nativeListeners.push(await p.addListener(event, handler));
    };
    await add('state', (data) => {
      if (typeof data?.level === 'number') this.options.onLevel?.(data.level);
      if (data?.phase && data.phase !== this.phase) this._emit({ phase: data.phase });
    });
    await add('turn', (data) => {
      try { this.options.onNativeTurn?.({ transcript: data?.transcript || '', reply: data?.reply || '' }); } catch {}
    });
    await add('action', (data) => {
      try { if (data?.action) this.options.onNativeAction?.(data.action); } catch {}
    });
    await add('needsToken', async () => {
      try { await p.updateSession(await this.options.getAccessSession()); } catch {}
    });
    await add('stopped', (data) => {
      if (!this.active || this.engine !== 'native') return;
      this.active = false;
      this.engine = null;
      this._removeNativeListeners();
      this._emit({ phase: 'idle', message: data?.message || undefined });
    });
  }

  _removeNativeListeners() {
    for (const handle of this.nativeListeners.splice(0)) {
      try { handle.remove(); } catch {}
    }
  }
}
