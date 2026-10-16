package com.smartz.assistant.driving;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Speaks replies: the cloud voice chunks from the server, one after another,
 * or the phone's own voice when the cloud failed (if the user allows it).
 * Blocking calls, made from the driving loop thread; interrupt() from any thread.
 */
final class ReplyPlayer {
    private final Context context;
    private final AudioAttributes attributes;
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private final List<String> triedEngines = new ArrayList<>();
    private volatile boolean interrupted = false;
    private volatile MediaPlayer current;
    private volatile CountDownLatch waiting;

    ReplyPlayer(Context context) {
        this.context = context.getApplicationContext();
        int usage = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? AudioAttributes.USAGE_ASSISTANT : AudioAttributes.USAGE_MEDIA;
        this.attributes = new AudioAttributes.Builder()
            .setUsage(usage)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();
        bindEngine(null);
    }

    /**
     * Binds the phone's speech engine: the default one first, then any other
     * installed engine, until one actually speaks Arabic. Some phones ship a
     * default engine without Arabic or one that stops answering after an
     * update; staying on it is what made driving mode go silent.
     */
    private synchronized void bindEngine(String enginePackage) {
        ttsReady = false;
        TextToSpeech previous = tts;
        tts = null;
        if (previous != null) {
            try { previous.shutdown(); } catch (RuntimeException ignored) { }
        }
        triedEngines.add(enginePackage == null ? "" : enginePackage);
        final TextToSpeech[] holder = new TextToSpeech[1];
        TextToSpeech.OnInitListener listener = status -> {
            TextToSpeech engine = holder[0];
            if (engine == null) return;
            if (status != TextToSpeech.SUCCESS) {
                tryNextEngine(engine);
                return;
            }
            int result = engine.setLanguage(new Locale("ar", "SA"));
            if (result < 0) result = engine.setLanguage(new Locale("ar"));
            if (result < 0) {
                tryNextEngine(engine);
                return;
            }
            engine.setAudioAttributes(attributes);
            ttsReady = true;
        };
        holder[0] = enginePackage == null
            ? new TextToSpeech(context, listener)
            : new TextToSpeech(context, listener, enginePackage);
        tts = holder[0];
    }

    /** The current engine cannot speak Arabic: move to the next installed engine, if any. */
    private void tryNextEngine(TextToSpeech failed) {
        String next = null;
        try {
            for (TextToSpeech.EngineInfo info : failed.getEngines()) {
                if (!triedEngines.contains(info.name)) {
                    next = info.name;
                    break;
                }
            }
        } catch (RuntimeException ignored) { }
        if (next != null) bindEngine(next);
    }

    /** Starts over from the default engine (after a refusal or silence). */
    private void rebind() {
        triedEngines.clear();
        bindEngine(null);
    }

    AudioAttributes attributes() {
        return attributes;
    }

    /** Plays [{ mime, data(base64) }, ...]. Returns false when interrupted or nothing could be played. */
    boolean playChunks(JSONArray chunks) {
        interrupted = false;
        if (chunks == null || chunks.length() == 0) return false;
        boolean playedAny = false;
        for (int i = 0; i < chunks.length() && !interrupted; i++) {
            JSONObject chunk = chunks.optJSONObject(i);
            if (chunk == null) continue;
            try {
                byte[] audio = Base64.decode(chunk.optString("data", ""), Base64.DEFAULT);
                playedAny |= playBytes(audio, chunk.optString("mime", ""), i);
            } catch (IllegalArgumentException error) {
                // skip a broken chunk
            }
        }
        return playedAny && !interrupted;
    }

    /** One audio file in memory (also used for /api/speech responses). */
    boolean playBytes(byte[] audio, String mime, int index) {
        if (audio == null || audio.length == 0) return false;
        File file = new File(context.getCacheDir(), "drive-reply-" + index + extensionFor(mime == null ? "" : mime));
        try {
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(audio);
            }
            return playFile(file);
        } catch (IOException error) {
            return false;
        } finally {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    /** True when the last playback was stopped by interrupt() rather than failing. */
    boolean wasInterrupted() {
        return interrupted;
    }

    /** Clears a previous interrupt before a new reply. */
    void resetInterrupt() {
        interrupted = false;
    }

    private boolean playFile(File file) {
        CountDownLatch done = new CountDownLatch(1);
        MediaPlayer player = new MediaPlayer();
        final boolean[] ok = { true };
        try {
            player.setAudioAttributes(attributes);
            player.setDataSource(file.getAbsolutePath());
            player.setOnCompletionListener(p -> done.countDown());
            player.setOnErrorListener((p, what, extra) -> {
                ok[0] = false;
                done.countDown();
                return true;
            });
            player.prepare();
            waiting = done;
            current = player;
            if (interrupted) return false;
            player.start();
            done.await(120, TimeUnit.SECONDS);
            return ok[0] && !interrupted;
        } catch (IOException | IllegalStateException | IllegalArgumentException error) {
            return false;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return false;
        } finally {
            current = null;
            waiting = null;
            player.release();
        }
    }

    /** The phone's voice (the "heavy" one) — only used when the cloud voice failed. */
    boolean speakWithDevice(String text) {
        interrupted = false;
        if (text == null || text.trim().isEmpty()) return false;
        for (int attempt = 0; attempt < 2 && !interrupted; attempt++) {
            int result = speakOnce(text);
            if (result == 1) return !interrupted;
            if (result == 0 || interrupted) return false;
            rebind(); // refused or silent: bind again (maybe another engine) and try once more
        }
        return false;
    }

    /** 1 = spoken, 0 = gave up (no engine / interrupted), -1 = refused or never started. */
    private int speakOnce(String text) {
        for (int i = 0; i < 50 && !ttsReady && !interrupted; i++) {
            try {
                Thread.sleep(100);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return 0;
            }
        }
        TextToSpeech engine = tts;
        if (!ttsReady || engine == null) return -1;
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(1);
        String id = "drive-" + System.nanoTime();
        engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String utteranceId) { started.countDown(); }
            @Override public void onDone(String utteranceId) { started.countDown(); done.countDown(); }
            @Override public void onError(String utteranceId) { done.countDown(); }
            @Override public void onStop(String utteranceId, boolean interrupted) { started.countDown(); done.countDown(); }
        });
        waiting = done;
        try {
            if (engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) return -1;
            if (!started.await(8, TimeUnit.SECONDS)) {
                engine.stop();
                return -1; // the engine accepted but never spoke
            }
            done.await(90, TimeUnit.SECONDS);
            return 1;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return 0;
        } catch (RuntimeException error) {
            return -1;
        } finally {
            waiting = null;
        }
    }

    /** Stops whatever is speaking now (a tap, the bubble, the steering-wheel button). */
    void interrupt() {
        interrupted = true;
        MediaPlayer player = current;
        if (player != null) {
            try { player.stop(); } catch (IllegalStateException ignored) { }
        }
        if (tts != null) tts.stop();
        CountDownLatch latch = waiting;
        if (latch != null) latch.countDown();
    }

    void release() {
        interrupt();
        if (tts != null) {
            tts.shutdown();
            tts = null;
        }
    }

    private static String extensionFor(String mime) {
        if (mime.contains("mpeg") || mime.contains("mp3")) return ".mp3";
        if (mime.contains("ogg") || mime.contains("opus")) return ".ogg";
        if (mime.contains("aac") || mime.contains("mp4")) return ".m4a";
        return ".wav";
    }
}
