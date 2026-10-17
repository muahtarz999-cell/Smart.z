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
  noiseFactor: 3, // the bar in a quiet room: 3x the noise (~10 dB)
  noisyFactor: 2, // the bar in a loud car: 2x the noise (~6 dB), so speech still clears it
  quietFloor: 0.01, // at or below this floor the quiet factor applies…
  noisyFloor: 0.03, // …at or above this one the noisy factor; in between it slides
  floorAdapt: 0.05,
  floorFall: 0.2, // the floor drops quickly when the room gets quieter…
  floorCreep: 0.005, // …and rises only slowly on frames well above it (unrecognised speech)
  calibrationMs: 300,
  keepRatio: 0.7,
  voicedFactor: 1.4, // when the classifier hears a voice, 1.4x the room is enough (a voice from the driver's seat)
  minVoicedThreshold: 0.004,
});

export function createSpeechDetector(options = {}) {
  const o = { ...SPEECH_DETECTOR_DEFAULTS, ...options };
  let state = 'waiting'; // waiting | speaking
  let floor = null;
  let loudRun = 0;
  let quietRun = 0;
  let speechFrames = 0;
  let calibrationLeft = Math.max(1, Math.round(o.calibrationMs / o.frameMs));

  // The louder the room, the smaller the margin speech needs above it: road
  // noise at 0.03 would otherwise put the bar above a normal voice.
  const factor = () => {
    const f = floor ?? 0;
    const t = Math.min(1, Math.max(0, (f - o.quietFloor) / (o.noisyFloor - o.quietFloor)));
    return o.noiseFactor + (o.noisyFactor - o.noiseFactor) * t;
  };
  const threshold = () => Math.min(o.maxThreshold, Math.max(o.minThreshold, (floor ?? 0) * factor()));
  const voicedThreshold = () => Math.min(threshold(), Math.max(o.minVoicedThreshold, (floor ?? 0) * o.voicedFactor));
  const barFor = (voiced) => (voiced === true ? voicedThreshold() : threshold());

  // Follows the room while nobody speaks. Frames well above the floor are
  // likely the user talking softly, so they must not drag the floor up with
  // them (that pushed the bar out of reach in a noisy car).
  function adaptFloor(level) {
    if (level < floor) floor += (level - floor) * o.floorFall;
    else if (level < floor * 1.5) floor += (level - floor) * o.floorAdapt;
    else floor += (level - floor) * o.floorCreep;
  }

  function reset() {
    state = 'waiting';
    loudRun = 0;
    quietRun = 0;
    speechFrames = 0;
  }

  /**
   * Returns null, 'start', 'end' (send it), 'discard' (too short) or 'max' (send it, hit the limit).
   * voiced: what a speech classifier (Silero VAD on Android) says about this frame —
   * true (a human voice), false (not a voice: engine, fan, music) or undefined (no classifier,
   * loudness alone decides, as before).
   */
  function push(rms, voiced) {
    const level = Number.isFinite(rms) ? Math.max(0, rms) : 0;
    if (calibrationLeft > 0) {
      // The first frames only measure the room (quietest frame wins).
      floor = floor === null ? level : Math.min(floor, level);
      calibrationLeft -= 1;
      return null;
    }
    if (state === 'waiting') {
      if (voiced === false) {
        // Loud but not a voice: it is the room, however loud, and never starts a sentence.
        floor += (level - floor) * (level < floor ? o.floorFall : o.floorAdapt);
        loudRun = 0;
        return null;
      }
      const bar = barFor(voiced);
      // A voice does not raise the room's level; only sounds below the bar do.
      if (voiced !== true || level <= bar) adaptFloor(level);
      if (level > bar) {
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
    // Noise that is not a voice counts as a pause, so a sentence ends in a loud car instead of running to the limit.
    if (level > barFor(voiced) * o.keepRatio && voiced !== false) quietRun = 0;
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
