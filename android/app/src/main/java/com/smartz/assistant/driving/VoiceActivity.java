package com.smartz.assistant.driving;

import android.content.Context;
import com.konovalov.vad.silero.VadSilero;
import com.konovalov.vad.silero.config.FrameSize;
import com.konovalov.vad.silero.config.Mode;
import com.konovalov.vad.silero.config.SampleRate;

/**
 * Tells a human voice apart from steady noise (engine, fan, road, music) with
 * Silero VAD, a small speech model bundled in the app (android-vad, MIT;
 * the model ships inside the APK, nothing is downloaded at run time).
 *
 * Works on 512-sample windows at 16 kHz (32 ms). If the model cannot load on
 * a phone, isSpeech() returns null and driving mode falls back to loudness
 * alone, as before.
 */
final class VoiceActivity {
    static final int WINDOW = 512;

    private VadSilero vad;

    VoiceActivity(Context context) {
        try {
            vad = new VadSilero(
                context.getApplicationContext(),
                SampleRate.SAMPLE_RATE_16K,
                FrameSize.FRAME_SIZE_512,
                Mode.NORMAL,
                0,
                0
            );
        } catch (Throwable error) {
            // Missing native runtime or model on this phone: loudness alone decides.
            vad = null;
        }
    }

    boolean available() {
        return vad != null;
    }

    /**
     * frame: MicListener's frame (3 windows of 512 samples). TRUE when most
     * windows hold a voice, FALSE when none or one does, null without a model.
     */
    synchronized Boolean isSpeech(short[] frame) {
        if (vad == null || frame == null || frame.length < WINDOW) return null;
        int windows = frame.length / WINDOW;
        int voiced = 0;
        short[] window = new short[WINDOW];
        try {
            for (int i = 0; i < windows; i++) {
                System.arraycopy(frame, i * WINDOW, window, 0, WINDOW);
                if (vad.isSpeech(window)) voiced++;
            }
        } catch (Throwable error) {
            close();
            return null;
        }
        return voiced * 2 > windows;
    }

    synchronized void close() {
        if (vad == null) return;
        try {
            vad.close();
        } catch (Throwable ignored) {
            // already closed
        }
        vad = null;
    }
}
