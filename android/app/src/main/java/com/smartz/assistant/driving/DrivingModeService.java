package com.smartz.assistant.driving;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import com.smartz.assistant.R;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Driving mode in the background: a foreground service (type microphone)
 * that keeps the conversation open while Maps or any other app is in front,
 * or the screen is locked.
 *
 *   listen (MicListener, phone mic, echo cancelled)
 *     → POST /api/drive/turn  (transcript + reply + cloud voice in one request)
 *     → speak (ReplyPlayer; phone voice only if the cloud failed and the user allows it)
 *     → execute a WhatsApp send after the undo window, or leave it in the app for a tap
 *     → listen again
 *
 * The microphone is closed while the reply plays (half duplex), so the
 * assistant never answers itself. Ends on "وضع القيادة انتهى", the
 * notification's "إنهاء", dragging the bubble to the bottom, or 10 minutes
 * of silence. Nothing is stored here: the conversation context came from
 * the app and turns go back to it (DriveEvents).
 */
public class DrivingModeService extends Service implements BubbleOverlay.Actions {
    public static final String ACTION_STOP = "com.smartz.assistant.driving.STOP";
    private static final String CHANNEL_ID = "smartz_driving_mode";
    private static final int NOTIFICATION_ID = 7301;
    private static final int HISTORY_MESSAGES = 6;
    private static final long TOKEN_MARGIN_MS = 90_000;
    private static final long MAX_SESSION_MS = 4L * 60 * 60 * 1000;

    private static volatile DrivingModeService instance;
    private static volatile JSONObject pendingConfig;
    private static volatile boolean appVisible = true;

    private final Object tokenLock = new Object();
    private final ConcurrentLinkedQueue<String> notices = new ConcurrentLinkedQueue<>();
    private Handler main;
    private ReplyPlayer player;
    private MicListener mic;
    private ScheduledExecutorService scheduler;
    private BubbleOverlay bubble;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> { };
    private MediaSession mediaSession;
    private PowerManager.WakeLock wakeLock;

    private volatile boolean running = false;
    private volatile boolean stopping = false;
    private volatile String phase = "listening";
    private volatile String token = "";
    private volatile long expiresAt = 0;
    private String baseUrl = "";
    private JSONObject config = new JSONObject();
    private JSONArray history = new JSONArray();
    private long idleMs = 10 * 60_000L;
    private int undoSeconds = 5;
    private boolean confirmEverySend = false;
    private boolean deviceFallback = true;
    private boolean bubbleEnabled = true;
    private ScheduledFuture<?> pendingSend;
    private JSONObject pendingAction;
    private long lastLevelEmit = 0;
    private int failures = 0;

    // ------------------------------------------------------------------ API for DrivingModePlugin

    public static boolean isRunning() {
        DrivingModeService service = instance;
        return service != null && service.running;
    }

    /** Must be called while the app is on screen (Android only lets a visible app start the microphone). */
    public static void start(Context context, JSONObject config) {
        pendingConfig = config;
        ContextCompat.startForegroundService(context, new Intent(context, DrivingModeService.class));
    }

    public static void requestStop(String reason, boolean announce) {
        DrivingModeService service = instance;
        if (service != null) service.stopDriving(reason, announce);
    }

    public static void interruptSpeech() {
        DrivingModeService service = instance;
        if (service != null) service.player.interrupt();
    }

    public static void updateSession(String accessToken, long expiresAtMs) {
        DrivingModeService service = instance;
        if (service == null || accessToken == null || accessToken.isEmpty()) return;
        synchronized (service.tokenLock) {
            service.token = accessToken;
            service.expiresAt = expiresAtMs;
            service.tokenLock.notifyAll();
        }
    }

    /** Merges context the app refreshed while driving; only the known keys are taken. */
    public static void updateContext(JSONObject next) {
        DrivingModeService service = instance;
        if (service == null || next == null) return;
        synchronized (service) {
            for (String key : new String[] { "inbox", "profile", "memories" }) {
                if (next.has(key)) put(service.config, key, next.opt(key));
            }
        }
    }

    /** The app screen is in front (no bubble needed) or not (show the bubble). */
    public static void setAppVisible(boolean visible) {
        appVisible = visible;
        DrivingModeService service = instance;
        if (service != null) service.main.post(service::refreshBubble);
    }

    // ------------------------------------------------------------------ service lifecycle

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        main = new Handler(Looper.getMainLooper());
        player = new ReplyPlayer(this);
        mic = new MicListener();
        scheduler = Executors.newSingleThreadScheduledExecutor();
        bubble = new BubbleOverlay(this, this);
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopDriving("user", true);
            return START_NOT_STICKY;
        }
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification("أستمع…"), type);
        } catch (RuntimeException error) {
            // Android refused a background microphone (app not visible, or permission missing).
            pendingConfig = null;
            emitStopped("error", "لم يسمح Android بتشغيل الميكروفون في الخلفية. افتح التطبيق وأعد المحاولة.");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (running) return START_NOT_STICKY;

        JSONObject next = pendingConfig;
        pendingConfig = null;
        if (next == null) { // restarted by the system without a conversation to continue
            stopSelf();
            return START_NOT_STICKY;
        }
        applyConfig(next);
        running = true;
        stopping = false;
        acquireWakeLock();
        requestFocus();
        startMediaSession();
        refreshBubble();
        Thread loop = new Thread(this::runLoop, "smartz-driving");
        loop.start();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        mic.abort();
        player.release();
        scheduler.shutdown();
        bubble.hide();
        releaseFocus();
        if (mediaSession != null) mediaSession.release();
        releaseWakeLock();
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void applyConfig(JSONObject next) {
        config = next;
        baseUrl = next.optString("baseUrl", "").replaceAll("/+$", "");
        token = next.optString("accessToken", "");
        DriveClient.deviceId = next.optString("deviceId", "");
        expiresAt = next.optLong("expiresAt", 0);
        JSONArray seed = next.optJSONArray("history");
        history = seed != null ? seed : new JSONArray();
        idleMs = Math.max(1, next.optInt("idleMinutes", 10)) * 60_000L;
        undoSeconds = Math.max(0, Math.min(30, next.optInt("undoSeconds", 5)));
        confirmEverySend = next.optBoolean("confirmEverySend", false);
        JSONObject voice = next.optJSONObject("voice");
        deviceFallback = voice == null || voice.optBoolean("deviceFallback", true);
        bubbleEnabled = next.optBoolean("bubble", true);
        failures = 0;
    }

    // ------------------------------------------------------------------ the conversation loop

    private void runLoop() {
        say(config.optString("startMessage", "وضع القيادة يعمل."));
        long startedAt = SystemClock.elapsedRealtime();
        long lastActivity = startedAt;
        while (running) {
            String notice = notices.poll();
            if (notice != null) {
                say(notice);
                continue;
            }
            long now = SystemClock.elapsedRealtime();
            long remaining = idleMs - (now - lastActivity);
            if (remaining <= 0 || now - startedAt > MAX_SESSION_MS) {
                stopDriving("idle", true);
                return;
            }

            setPhase("listening");
            byte[] wav;
            try {
                wav = mic.listen(remaining, this::publishLevel);
                failures = 0;
            } catch (MicListener.MicException error) {
                if (!running) return;
                failures += 1;
                if (failures >= 3) {
                    say(error.getMessage() + " أوقفت وضع القيادة.");
                    stopDriving("error", false);
                    return;
                }
                say(error.getMessage());
                sleep(3000);
                continue;
            }
            if (!running) return;
            if (wav == null) continue; // idle check or a notice

            setPhase("thinking");
            handleTurn(wav);
            lastActivity = SystemClock.elapsedRealtime();
        }
    }

    private void handleTurn(byte[] wav) {
        ensureFreshToken();
        DriveClient.Result result;
        try {
            result = DriveClient.turn(baseUrl, token, wav, buildContext().toString());
        } catch (IOException error) {
            say("لا يوجد اتصال بالإنترنت. سأحاول مع جملتك التالية.");
            return;
        }
        if (!running) return;
        if (result.status == 401) {
            DriveEvents.emit("needsToken", new JSONObject(), false);
            say("انتهت جلسة الدخول. افتح التطبيق مرة واحدة لتجديدها.");
            return;
        }
        if (result.status == 403) {
            say(result.body.optString("message", "الحساب غير مفعّل."));
            stopDriving("error", false);
            return;
        }
        if (!result.ok()) {
            say(result.body.optString("message", "تعذر الرد الآن. أعد المحاولة."));
            return;
        }

        JSONObject body = result.body;
        String kind = body.optString("kind", "reply");
        if ("ignored".equals(kind)) return;
        String transcript = body.optString("transcript", "");
        String reply = body.optString("reply", "");
        if ("error".equals(kind) || reply.isEmpty()) {
            say(body.optString("message", "لم يصل رد. أعد المحاولة."));
            return;
        }

        JSONArray audio = body.optJSONArray("audio");
        if ("cancel_send".equals(kind) && !cancelPendingSend()) {
            reply = "الرسالة أُرسلت قبل الإلغاء.";
            audio = null;
        }
        remember(transcript, reply);
        JSONObject turn = new JSONObject();
        put(turn, "transcript", transcript);
        put(turn, "reply", reply);
        DriveEvents.emit("turn", turn, true);

        speakReply(audio, reply);

        if ("stop".equals(kind)) {
            stopDriving("user", false);
            return;
        }
        JSONObject action = body.optJSONObject("action");
        if (action != null) {
            if ("service".equals(body.optString("actionDelivery"))) {
                scheduleSend(action);
            } else {
                JSONObject event = new JSONObject();
                put(event, "action", action);
                DriveEvents.emit("action", event, true); // waits in the app for a tap
            }
        }
    }

    private JSONObject buildContext() {
        JSONObject context = new JSONObject();
        put(context, "history", history);
        put(context, "profile", config.opt("profile"));
        put(context, "memories", config.opt("memories"));
        put(context, "inbox", config.opt("inbox")); // WhatsApp messages stored on the phone, for "لخص رسائلي"
        put(context, "preferences", config.opt("preferences"));
        put(context, "voice", config.opt("voice"));
        put(context, "confirmEverySend", confirmEverySend);
        synchronized (this) {
            put(context, "pendingSend", pendingAction != null);
        }
        return context;
    }

    private void remember(String transcript, String reply) {
        JSONArray next = new JSONArray();
        for (int i = 0; i < history.length(); i++) next.put(history.opt(i));
        if (!transcript.isEmpty()) next.put(message("user", transcript));
        if (!reply.isEmpty()) next.put(message("assistant", reply));
        JSONArray trimmed = new JSONArray();
        for (int i = Math.max(0, next.length() - HISTORY_MESSAGES); i < next.length(); i++) trimmed.put(next.opt(i));
        history = trimmed;
    }

    private static JSONObject message(String role, String content) {
        JSONObject entry = new JSONObject();
        put(entry, "role", role);
        put(entry, "content", content);
        return entry;
    }

    // ------------------------------------------------------------------ speaking

    /** The server's cloud audio; the phone's voice only if that failed and the user allows it. */
    private void speakReply(JSONArray audio, String text) {
        setPhase("speaking");
        player.resetInterrupt();
        boolean played = player.playChunks(audio);
        if (!played && !player.wasInterrupted() && deviceFallback) player.speakWithDevice(text);
    }

    /** Short app messages (start, stop, errors): cloud voice via /api/speech, else the phone's voice. */
    private void say(String text) {
        if (text == null || text.isEmpty()) return;
        setPhase("speaking");
        player.resetInterrupt();
        byte[][] audio = baseUrl.isEmpty() ? null : DriveClient.speech(baseUrl, token, text, config.optJSONObject("voice"));
        boolean played = audio != null && player.playBytes(audio[0], new String(audio[1], StandardCharsets.UTF_8), 99);
        if (!played && !player.wasInterrupted() && deviceFallback) player.speakWithDevice(text);
    }

    // ------------------------------------------------------------------ WhatsApp sends

    private synchronized void scheduleSend(JSONObject action) {
        if (pendingSend != null) pendingSend.cancel(false);
        pendingAction = action;
        pendingSend = scheduler.schedule(() -> executeSend(action), undoSeconds, TimeUnit.SECONDS);
    }

    /** "تراجع" during the undo window. Returns false when it was already sent. */
    private synchronized boolean cancelPendingSend() {
        if (pendingAction == null || pendingSend == null) return false;
        boolean cancelled = pendingSend.cancel(false);
        if (cancelled) {
            pendingAction = null;
            pendingSend = null;
        }
        return cancelled;
    }

    private void executeSend(JSONObject action) {
        synchronized (this) {
            if (pendingAction != action) return;
            pendingAction = null;
            pendingSend = null;
        }
        String names = names(action.optJSONArray("recipients"));
        try {
            ensureFreshToken();
            JSONObject body = new JSONObject();
            body.put("recipients", action.optJSONArray("recipients"));
            body.put("text", action.optString("text", ""));
            body.put("manualConfirmation", false);
            DriveClient.Result result = DriveClient.postJson(baseUrl, "/api/whatsapp/cluster/send", token, body);
            if (!result.ok() || result.body.optInt("failed", 0) > 0) {
                notice("تعذر إرسال الرسالة إلى " + names + ".");
            }
        } catch (IOException | JSONException error) {
            notice("تعذر إرسال الرسالة إلى " + names + "، لا يوجد اتصال.");
        }
    }

    /** Something to tell the driver: interrupts listening and is spoken next. */
    private void notice(String text) {
        notices.add(text);
        mic.abort();
    }

    private static String names(JSONArray recipients) {
        if (recipients == null || recipients.length() == 0) return "المستلم";
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < recipients.length(); i++) {
            JSONObject recipient = recipients.optJSONObject(i);
            if (recipient == null) continue;
            if (out.length() > 0) out.append(i == recipients.length() - 1 ? " و" : "، ");
            out.append(recipient.optString("name", ""));
        }
        return out.toString();
    }

    // ------------------------------------------------------------------ access token

    /** Asks the app for a fresh token shortly before the current one expires (waits up to 8 s). */
    private void ensureFreshToken() {
        if (expiresAt <= 0 || expiresAt - System.currentTimeMillis() > TOKEN_MARGIN_MS) return;
        synchronized (tokenLock) {
            long before = expiresAt;
            DriveEvents.emit("needsToken", new JSONObject(), false);
            long deadline = SystemClock.elapsedRealtime() + 8_000;
            while (expiresAt == before && SystemClock.elapsedRealtime() < deadline) {
                try {
                    tokenLock.wait(Math.max(1, deadline - SystemClock.elapsedRealtime()));
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    // ------------------------------------------------------------------ stopping

    /** reason: user | idle | error | service. Safe from any thread. */
    void stopDriving(String reason, boolean announce) {
        synchronized (this) {
            if (stopping) return;
            stopping = true;
        }
        boolean wasRunning = running;
        running = false;
        mic.abort();
        player.interrupt();
        String message = "idle".equals(reason)
            ? "لم أسمع شيئاً منذ مدة، فأوقفت وضع القيادة."
            : "أنهيت وضع القيادة. قُد بأمان.";
        Runnable finish = () -> {
            emitStopped(reason, null);
            main.post(() -> {
                bubble.hide();
                releaseFocus();
                if (mediaSession != null) mediaSession.setActive(false);
                releaseWakeLock();
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
                stopSelf(); // a send still in its undo window is delivered before the executor ends
            });
        };
        if (announce && wasRunning) {
            new Thread(() -> {
                say(message);
                finish.run();
            }, "smartz-driving-stop").start();
        } else {
            finish.run();
        }
    }

    private void emitStopped(String reason, String message) {
        JSONObject data = new JSONObject();
        put(data, "reason", reason);
        if (message != null) put(data, "message", message);
        DriveEvents.emit("stopped", data, true);
    }

    // ------------------------------------------------------------------ bubble, notification, media button

    @Override
    public void onBubbleTap() {
        player.interrupt();
    }

    @Override
    public void onBubbleDismiss() {
        stopDriving("user", true);
    }

    private void refreshBubble() {
        if (running && bubbleEnabled && !appVisible && BubbleOverlay.canDraw(this)) bubble.show();
        else bubble.hide();
        bubble.update(phase, 0);
    }

    private void setPhase(String next) {
        if (!next.equals(phase)) {
            phase = next;
            updateNotification();
            updatePlaybackState();
        }
        bubble.update(next, 0);
        JSONObject data = new JSONObject();
        put(data, "phase", next);
        DriveEvents.emit("state", data, false);
    }

    private void publishLevel(float level) {
        bubble.update("listening", level);
        long now = SystemClock.elapsedRealtime();
        if (now - lastLevelEmit < 90) return;
        lastLevelEmit = now;
        JSONObject data = new JSONObject();
        put(data, "phase", "listening");
        put(data, "level", (double) level);
        DriveEvents.emit("state", data, false);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "وضع القيادة", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("يظهر أثناء استماع المساعد في وضع القيادة");
        channel.setShowBadge(false);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String text) {
        int immutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;
        Intent stop = new Intent(this, DrivingModeService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 1, stop, immutable | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent openIntent = open == null ? null
            : PendingIntent.getActivity(this, 2, open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), immutable | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_driving)
            .setContentTitle("Smart.z يستمع – وضع القيادة")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openIntent)
            .addAction(0, "إنهاء", stopIntent)
            .build();
    }

    @android.annotation.SuppressLint("MissingPermission") // without notification permission Android just hides it
    private void updateNotification() {
        String text = "speaking".equals(phase) ? "يتحدث… المس الفقاعة لإيقافه" : "thinking".equals(phase) ? "يفكر…" : "أستمع… تكلّم متى شئت";
        try {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null && running) manager.notify(NOTIFICATION_ID, buildNotification(text));
        } catch (RuntimeException ignored) {
            // notifications turned off: the service keeps running
        }
    }

    /** The steering-wheel / headset play-pause button stops the assistant talking. */
    private void startMediaSession() {
        try {
            mediaSession = new MediaSession(this, "SmartzDriving");
            mediaSession.setCallback(new MediaSession.Callback() {
                @Override public void onPlay() { player.interrupt(); }
                @Override public void onPause() { player.interrupt(); }
                @Override public void onStop() { player.interrupt(); }
            });
            mediaSession.setActive(true);
            updatePlaybackState();
        } catch (RuntimeException error) {
            mediaSession = null;
        }
    }

    private void updatePlaybackState() {
        if (mediaSession == null) return;
        int state = "speaking".equals(phase) ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
        mediaSession.setPlaybackState(new PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP)
            .setState(state, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
            .build());
    }

    /** Music and other apps are lowered (not stopped) while driving mode listens and speaks. */
    private void requestFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(player.attributes())
                .setOnAudioFocusChangeListener(focusListener)
                .build();
            audioManager.requestAudioFocus(focusRequest);
        } else {
            audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
        }
    }

    private void releaseFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
            focusRequest = null;
        } else {
            audioManager.abandonAudioFocus(focusListener);
        }
    }

    /** Keeps the CPU awake with the screen off; released when driving mode ends (4 h at most). */
    private void acquireWakeLock() {
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power == null) return;
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "smartz:driving");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(MAX_SESSION_MS);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value == null ? JSONObject.NULL : value);
        } catch (JSONException ignored) {
            // keys are constants; values are JSON-safe
        }
    }
}
