package com.smartz.assistant.driving;

/**
 * Where a sentence starts and ends, from per-frame loudness (RMS of samples
 * in [-1, 1]). Same logic and numbers as lib/speech-detector.js in the app:
 * the first 300 ms measure the room, the noise floor then follows it while
 * nobody speaks, speech starts after 200 ms above the bar and ends after
 * 900 ms below it; anything under 450 ms is a bump, not a sentence.
 * The bar is 3x the floor in a quiet room and 2x in a loud car, and frames
 * well above the floor (soft speech) barely move it, so road noise cannot
 * push the bar above a normal voice.
 */
final class SpeechDetector {
    static final int NONE = 0;
    static final int START = 1;
    static final int END = 2;
    static final int DISCARD = 3;
    static final int MAX = 4;

    private static final double START_MS = 200;
    private static final double SILENCE_MS = 900;
    private static final double MIN_SPEECH_MS = 450;
    private static final double MAX_SPEECH_MS = 30_000;
    private static final double MIN_THRESHOLD = 0.012;
    private static final double MAX_THRESHOLD = 0.25;
    private static final double NOISE_FACTOR = 3;
    private static final double NOISY_FACTOR = 2;
    private static final double QUIET_FLOOR = 0.01;
    private static final double NOISY_FLOOR = 0.03;
    private static final double FLOOR_ADAPT = 0.05;
    private static final double FLOOR_FALL = 0.2;
    private static final double FLOOR_CREEP = 0.005;
    private static final double CALIBRATION_MS = 300;
    private static final double KEEP_RATIO = 0.7;

    private final double frameMs;
    private boolean speaking = false;
    private double floor = -1;
    private int loudRun = 0;
    private int quietRun = 0;
    private int speechFrames = 0;
    private int calibrationLeft;

    SpeechDetector(double frameMs) {
        this.frameMs = frameMs;
        this.calibrationLeft = Math.max(1, (int) Math.round(CALIBRATION_MS / frameMs));
    }

    double threshold() {
        double f = Math.max(0, floor);
        double t = Math.min(1, Math.max(0, (f - QUIET_FLOOR) / (NOISY_FLOOR - QUIET_FLOOR)));
        double factor = NOISE_FACTOR + (NOISY_FACTOR - NOISE_FACTOR) * t;
        return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, f * factor));
    }

    private void adaptFloor(double level) {
        if (level < floor) floor += (level - floor) * FLOOR_FALL;
        else if (level < floor * 1.5) floor += (level - floor) * FLOOR_ADAPT;
        else floor += (level - floor) * FLOOR_CREEP;
    }

    boolean isSpeaking() {
        return speaking;
    }

    private void reset() {
        speaking = false;
        loudRun = 0;
        quietRun = 0;
        speechFrames = 0;
    }

    int push(double rms) {
        return push(rms, null);
    }

    /**
     * voiced: Silero VAD's verdict for this frame (TRUE a human voice, FALSE not a
     * voice), or null when no classifier is available and loudness alone decides.
     */
    int push(double rms, Boolean voiced) {
        double level = Double.isNaN(rms) || rms < 0 ? 0 : rms;
        if (calibrationLeft > 0) {
            floor = floor < 0 ? level : Math.min(floor, level);
            calibrationLeft -= 1;
            return NONE;
        }
        if (!speaking) {
            if (Boolean.FALSE.equals(voiced)) {
                // Loud but not a voice: it is the room, however loud, and never starts a sentence.
                floor += (level - floor) * (level < floor ? FLOOR_FALL : FLOOR_ADAPT);
                loudRun = 0;
                return NONE;
            }
            adaptFloor(level);
            if (level > threshold()) {
                loudRun += 1;
                if (loudRun * frameMs >= START_MS) {
                    speaking = true;
                    speechFrames = loudRun;
                    quietRun = 0;
                    return START;
                }
            } else {
                loudRun = 0;
            }
            return NONE;
        }

        speechFrames += 1;
        // Noise that is not a voice counts as a pause, so a sentence ends in a loud car.
        if (level > threshold() * KEEP_RATIO && !Boolean.FALSE.equals(voiced)) quietRun = 0;
        else quietRun += 1;

        if (speechFrames * frameMs >= MAX_SPEECH_MS) {
            reset();
            return MAX;
        }
        if (quietRun * frameMs >= SILENCE_MS) {
            double spokenMs = (speechFrames - quietRun) * frameMs;
            reset();
            return spokenMs >= MIN_SPEECH_MS ? END : DISCARD;
        }
        return NONE;
    }
}
