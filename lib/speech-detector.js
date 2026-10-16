/**
 * Decides where an utterance starts and ends from per-frame loudness (RMS of
 * samples in [-1, 1]). Pure logic: the web recorder and the Android service
 * (SpeechDetector.java, same numbers) feed it frames.
 *
 * - The first 300 ms measure the room; after that the noise floor follows the room while nobody speaks, so a car at 100 km/h
 *   raises the bar instead of triggering forever.
 * - Speech starts after `startMs` of loud frames and ends after `silenceMs` of
 *   quiet ones; anything shorter than `minSpeechMs` is discarded as a bump or
 *   a cough rather than sent for transcription.
 */

export const SPEECH_DETECTOR_DEFAULTS = Object.freeze({
  frameMs: 100,
  startMs: 200,
  silenceMs: 900,
  minSpeechMs: 450,
  maxSpeechMs: 30_000,
  minThreshold: 0.012,
  maxThreshold: 0.25,
  noiseFactor: 3,
  floorAdapt: 0.05,
  calibrationMs: 300,
  keepRatio: 0.7,
});

export function createSpeechDetector(options = {}) {
  const o = { ...SPEECH_DETECTOR_DEFAULTS, ...options };
  let state = 'waiting'; // waiting | speaking
  let floor = null;
  let loudRun = 0;
  let quietRun = 0;
  let speechFrames = 0;
  let calibrationLeft = Math.max(1, Math.round(o.calibrationMs / o.frameMs));

  const threshold = () => Math.min(o.maxThreshold, Math.max(o.minThreshold, (floor ?? 0) * o.noiseFactor));

  function reset() {
    state = 'waiting';
    loudRun = 0;
    quietRun = 0;
    speechFrames = 0;
  }

  /** Returns null, 'start', 'end' (send it), 'discard' (too short) or 'max' (send it, hit the limit). */
  function push(rms) {
    const level = Number.isFinite(rms) ? Math.max(0, rms) : 0;
    if (calibrationLeft > 0) {
      // The first frames only measure the room (quietest frame wins).
      floor = floor === null ? level : Math.min(floor, level);
      calibrationLeft -= 1;
      return null;
    }
    if (state === 'waiting') {
      floor += (level - floor) * o.floorAdapt;
      if (level > threshold()) {
        loudRun += 1;
        if (loudRun * o.frameMs >= o.startMs) {
          state = 'speaking';
          speechFrames = loudRun;
          quietRun = 0;
          return 'start';
        }
      } else {
        loudRun = 0;
      }
      return null;
    }

    speechFrames += 1;
    if (level > threshold() * o.keepRatio) quietRun = 0;
    else quietRun += 1;

    if (speechFrames * o.frameMs >= o.maxSpeechMs) {
      reset();
      return 'max';
    }
    if (quietRun * o.frameMs >= o.silenceMs) {
      const spokenMs = (speechFrames - quietRun) * o.frameMs;
      reset();
      return spokenMs >= o.minSpeechMs ? 'end' : 'discard';
    }
    return null;
  }

  return {
    push,
    reset,
    get state() { return state; },
    get threshold() { return threshold(); },
    get noiseFloor() { return floor ?? 0; },
  };
}
