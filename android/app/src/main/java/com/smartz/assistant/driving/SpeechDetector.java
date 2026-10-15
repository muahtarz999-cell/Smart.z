package com.smartz.assistant.driving;

/**
 * Where a sentence starts and ends, from per-frame loudness (RMS of samples
 * in [-1, 1]). Same logic and numbers as lib/speech-detector.js in the app:
 * the first 300 ms measure the room, the noise floor then follows it while
 * nobody speaks, speech starts after 200 ms above the bar and ends after
 * 900 ms below it; anything under 450 ms is a bump, not a sentence.
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
    private static final double FLOOR_ADAPT = 0.05;
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
        return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, Math.max(0, floor) * NOISE_FACTOR));
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
        double level = Double.isNaN(rms) || rms < 0 ? 0 : rms;
        if (calibrationLeft > 0) {
            floor = floor < 0 ? level : Math.min(floor, level);
            calibrationLeft -= 1;
            return NONE;
        }
        if (!speaking) {
            floor += (level - floor) * FLOOR_ADAPT;
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
        if (level > threshold() * KEEP_RATIO) quietRun = 0;
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
