package com.smartz.assistant.driving;

import android.annotation.SuppressLint;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.NoiseSuppressor;
import android.os.SystemClock;
import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;

/**
 * Records one sentence from the phone's microphone as a 16 kHz mono WAV.
 *
 * The VOICE_COMMUNICATION source switches on the phone's echo canceller and
 * noise suppressor, which also removes most of the music or navigation
 * prompts the phone itself is playing. Each frame is also checked by Silero
 * VAD (VoiceActivity), so a loud engine or fan is never taken for speech.
 * The microphone is opened per sentence and closed before the reply is spoken.
 */
final class MicListener {
    interface LevelSink {
        void onLevel(float level);
    }

    static final class MicException extends Exception {
        MicException(String message) {
            super(message);
        }
    }

    static final int SAMPLE_RATE = 16_000;
    private static final int FRAME_SAMPLES = VoiceActivity.WINDOW * 3; // 1536 samples = 96 ms, three VAD windows
    private static final int PRE_ROLL_FRAMES = 5; // 300 ms before + the 200 ms that triggered the start

    private volatile boolean aborted = false;
    private final VoiceActivity voiceActivity; // null or unavailable: loudness alone decides

    MicListener(VoiceActivity voiceActivity) {
        this.voiceActivity = voiceActivity;
    }

    void abort() {
        aborted = true;
    }

    /**
     * Blocks until a sentence was spoken (returns the WAV), the wait for speech
     * passed waitMs (returns null), or abort() was called (returns null).
     */
    @SuppressLint("MissingPermission") // checked by DrivingModePlugin before the service starts
    byte[] listen(long waitMs, LevelSink sink) throws MicException {
        aborted = false;
        int minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minBuffer <= 0) throw new MicException("الميكروفون غير متاح.");
        int bufferBytes = Math.max(minBuffer, FRAME_SAMPLES * 2 * 4);

        AudioRecord record = open(MediaRecorder.AudioSource.VOICE_COMMUNICATION, bufferBytes);
        if (record == null) record = open(MediaRecorder.AudioSource.VOICE_RECOGNITION, bufferBytes);
        if (record == null) record = open(MediaRecorder.AudioSource.MIC, bufferBytes);
        if (record == null) throw new MicException("تعذر فتح الميكروفون.");

        AcousticEchoCanceler echo = null;
        NoiseSuppressor noise = null;
        try {
            if (AcousticEchoCanceler.isAvailable()) {
                echo = AcousticEchoCanceler.create(record.getAudioSessionId());
                if (echo != null) echo.setEnabled(true);
            }
            if (NoiseSuppressor.isAvailable()) {
                noise = NoiseSuppressor.create(record.getAudioSessionId());
                if (noise != null) noise.setEnabled(true);
            }
        } catch (RuntimeException ignored) {
            // effects are a bonus; recording works without them
        }

        try {
            record.startRecording();
            if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                throw new MicException("الميكروفون مستخدم الآن (مكالمة أو تطبيق آخر).");
            }

            SpeechDetector detector = new SpeechDetector(FRAME_SAMPLES * 1000.0 / SAMPLE_RATE);
            ArrayDeque<short[]> ring = new ArrayDeque<>();
            ByteArrayOutputStream speech = null;
            long deadline = waitMs > 0 ? SystemClock.elapsedRealtime() + waitMs : Long.MAX_VALUE;

            while (!aborted) {
                short[] frame = new short[FRAME_SAMPLES];
                int filled = 0;
                while (filled < FRAME_SAMPLES && !aborted) {
                    int read = record.read(frame, filled, FRAME_SAMPLES - filled);
                    if (read < 0) throw new MicException("انقطع الميكروفون.");
                    filled += read;
                }
                if (aborted) return null;

                double sum = 0;
                for (short sample : frame) {
                    double value = sample / 32768.0;
                    sum += value * value;
                }
                double rms = Math.sqrt(sum / FRAME_SAMPLES);
                if (sink != null) sink.onLevel((float) Math.min(1, rms * 6));

                if (speech == null) {
                    ring.addLast(frame);
                    if (ring.size() > PRE_ROLL_FRAMES) ring.removeFirst();
                } else {
                    writeFrame(speech, frame);
                }

                Boolean voiced = voiceActivity != null ? voiceActivity.isSpeech(frame) : null;
                int event = detector.push(rms, voiced);
                if (event == SpeechDetector.START) {
                    speech = new ByteArrayOutputStream(SAMPLE_RATE * 2 * 6);
                    for (short[] earlier : ring) writeFrame(speech, earlier);
                    ring.clear();
                } else if (event == SpeechDetector.DISCARD) {
                    speech = null;
                } else if (event == SpeechDetector.END || event == SpeechDetector.MAX) {
                    return wav(speech.toByteArray());
                }

                if (speech == null && SystemClock.elapsedRealtime() > deadline) return null;
            }
            return null;
        } finally {
            try { record.stop(); } catch (RuntimeException ignored) { }
            record.release();
            if (echo != null) echo.release();
            if (noise != null) noise.release();
            if (sink != null) sink.onLevel(0);
        }
    }

    @SuppressLint("MissingPermission")
    private static AudioRecord open(int source, int bufferBytes) {
        try {
            AudioRecord record = new AudioRecord(source, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferBytes);
            if (record.getState() == AudioRecord.STATE_INITIALIZED) return record;
            record.release();
        } catch (RuntimeException ignored) {
            // try the next source
        }
        return null;
    }

    private static void writeFrame(ByteArrayOutputStream out, short[] frame) {
        for (short sample : frame) {
            out.write(sample & 0xff);
            out.write((sample >> 8) & 0xff);
        }
    }

    static byte[] wav(byte[] pcm) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(pcm.length + 44);
        writeAscii(out, "RIFF");
        writeInt(out, 36 + pcm.length);
        writeAscii(out, "WAVE");
        writeAscii(out, "fmt ");
        writeInt(out, 16);
        writeShort(out, 1);
        writeShort(out, 1);
        writeInt(out, SAMPLE_RATE);
        writeInt(out, SAMPLE_RATE * 2);
        writeShort(out, 2);
        writeShort(out, 16);
        writeAscii(out, "data");
        writeInt(out, pcm.length);
        out.write(pcm, 0, pcm.length);
        return out.toByteArray();
    }

    private static void writeAscii(ByteArrayOutputStream out, String text) {
        for (int i = 0; i < text.length(); i++) out.write(text.charAt(i));
    }

    private static void writeInt(ByteArrayOutputStream out, int value) {
        out.write(value & 0xff);
        out.write((value >> 8) & 0xff);
        out.write((value >> 16) & 0xff);
        out.write((value >> 24) & 0xff);
    }

    private static void writeShort(ByteArrayOutputStream out, int value) {
        out.write(value & 0xff);
        out.write((value >> 8) & 0xff);
    }
}
