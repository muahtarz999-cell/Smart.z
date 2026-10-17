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
 * The VOICE_RECOGNITION source is tuned for a voice at arm's length (the
 * phone in its car holder). Each frame is checked by Silero VAD
 * (VoiceActivity), so a loud engine or fan is never taken for speech, and a
 * quieter voice from the driver's seat still is.
 * The microphone is opened per sentence and closed before the reply is spoken.
 */
final class MicListener {
    interface LevelSink {
        /** level 0..1 for the wave; threshold and voiced are what the detector compared (for the on-screen check). */
        void onFrame(float level, double threshold, Boolean voiced);
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

    // Safety valve: if the voice model keeps saying "not a voice" for sound that is
    // clearly loud and it has never once said "voice", it is not working on this
    // phone; it is switched off for the session so the driver is still heard.
    private static final int DISTRUST_AFTER_FRAMES = 25; // ~2.4 s of loud audio rejected
    private int loudRejected = 0;
    private boolean everVoiced = false;
    private double quietest = Double.MAX_VALUE; // the quietest frame this session: the room without anyone talking
    private volatile boolean vadOff = false;

    MicListener(VoiceActivity voiceActivity) {
        this.voiceActivity = voiceActivity;
    }

    /** on | off (switched off by the safety valve) | unavailable (no model on this phone). */
    String vadState() {
        if (voiceActivity == null || !voiceActivity.available()) return "unavailable";
        return vadOff ? "off" : "on";
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

        // VOICE_RECOGNITION is tuned for a voice at arm's length (a phone in its car
        // holder). VOICE_COMMUNICATION is tuned for a phone at the ear: its call
        // processing pulled a voice 50 cm away below the bar, so the driver had to
        // speak into the microphone to be heard.
        AudioRecord record = open(MediaRecorder.AudioSource.VOICE_RECOGNITION, bufferBytes);
        if (record == null) record = open(MediaRecorder.AudioSource.MIC, bufferBytes);
        if (record == null) record = open(MediaRecorder.AudioSource.VOICE_COMMUNICATION, bufferBytes);
        if (record == null) throw new MicException("تعذر فتح الميكروفون.");

        AcousticEchoCanceler echo = null;
        NoiseSuppressor noise = null;
        try {
            if (AcousticEchoCanceler.isAvailable()) {
                echo = AcousticEchoCanceler.create(record.getAudioSessionId());
                if (echo != null) echo.setEnabled(true);
            }
            // No NoiseSuppressor: it treats a distant voice as noise. Silero VAD
            // tells voice from road noise instead (VoiceActivity).
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
                Boolean voiced = vadOff || voiceActivity == null ? null : voiceActivity.isSpeech(frame);
                if (Boolean.TRUE.equals(voiced)) everVoiced = true;
                quietest = Math.min(quietest, rms);
                // Measured against the quiet room, not the detector's bar (which rises while the model says "noise").
                if (Boolean.FALSE.equals(voiced) && !everVoiced && rms > Math.max(0.02, quietest * 4)) {
                    loudRejected++;
                    if (loudRejected >= DISTRUST_AFTER_FRAMES) {
                        vadOff = true;
                        voiced = null;
                        // The rejected frames raised the bar; go back to the quiet room so the voice is heard now.
                        detector.reseed(quietest);
                    }
                }
                if (sink != null) sink.onFrame((float) Math.min(1, rms * 6), detector.threshold(), voiced);

                if (speech == null) {
                    ring.addLast(frame);
                    if (ring.size() > PRE_ROLL_FRAMES) ring.removeFirst();
                } else {
                    writeFrame(speech, frame);
                }

                int event = detector.push(rms, voiced);
                if (event == SpeechDetector.START) {
                    speech = new ByteArrayOutputStream(SAMPLE_RATE * 2 * 6);
                    for (short[] earlier : ring) writeFrame(speech, earlier);
                    ring.clear();
                } else if (event == SpeechDetector.DISCARD) {
                    speech = null;
                } else if (event == SpeechDetector.END || event == SpeechDetector.MAX) {
                    return wav(louder(speech.toByteArray()));
                }

                if (speech == null && SystemClock.elapsedRealtime() > deadline) return null;
            }
            return null;
        } finally {
            try { record.stop(); } catch (RuntimeException ignored) { }
            record.release();
            if (echo != null) echo.release();
            if (noise != null) noise.release();
            if (sink != null) sink.onFrame(0, 0, null);
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

    static final double TARGET_PEAK = 0.7;
    static final double MAX_GAIN = 8;

    /**
     * A sentence said from the driver's seat arrives quiet; it is raised (up to
     * 8x, peak at 70%) before it is sent, so speech-to-text hears it as clearly
     * as a voice close to the phone. Loud sentences are left as they are.
     */
    static byte[] louder(byte[] pcm) {
        int peak = 1;
        for (int i = 0; i + 1 < pcm.length; i += 2) {
            int sample = (short) ((pcm[i] & 0xff) | (pcm[i + 1] << 8));
            peak = Math.max(peak, Math.abs(sample));
        }
        double gain = Math.min(MAX_GAIN, TARGET_PEAK * 32767 / peak);
        if (gain <= 1.05) return pcm;
        byte[] out = new byte[pcm.length];
        for (int i = 0; i + 1 < pcm.length; i += 2) {
            int sample = (short) ((pcm[i] & 0xff) | (pcm[i + 1] << 8));
            int raised = (int) Math.max(-32768, Math.min(32767, Math.round(sample * gain)));
            out[i] = (byte) (raised & 0xff);
            out[i + 1] = (byte) ((raised >> 8) & 0xff);
        }
        return out;
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
