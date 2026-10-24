package com.smartz.assistant.calls;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.ContactsContract;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.telecom.TelecomManager;
import android.telephony.TelephonyManager;
import androidx.core.content.ContextCompat;
import com.smartz.assistant.R;
import com.smartz.assistant.driving.DrivingModeService;
import java.util.Locale;

/**
 * The call assistant (owner request 2026-10-22): when the phone rings it says who
 * is calling and offers answer / reject / reject with a message, from the
 * notification or, in driving mode, by voice. On when the user switches it on,
 * and always on while driving mode runs. Android does not let an app talk to the
 * caller, so answering hands the call to the user.
 */
public final class CallAssistant {
    static final String PREFS = "smartz_call_assistant";
    static final String CHANNEL_ID = "smartz_calls";
    static final int NOTIFICATION_ID = 4812;
    public static final String DEFAULT_MESSAGE = "مشغول الآن، سأتواصل معك لاحقًا.";
    private static final long RINGING_TTL_MS = 2 * 60 * 1000;

    private CallAssistant() { }

    /** The call ringing now (number as the phone shows it, display name). */
    public static final class Ringing {
        public final String number;
        public final String name;
        final long at;

        Ringing(String number, String name, long at) {
            this.number = number;
            this.name = name;
            this.at = at;
        }
    }

    private static volatile Ringing ringing;
    private static volatile boolean inCall;
    private static TextToSpeech tts;

    // ------------------------------------------------------------------ settings

    public static boolean isEnabled(Context context) {
        return prefs(context).getBoolean("enabled", false);
    }

    public static String message(Context context) {
        String saved = prefs(context).getString("message", "");
        return saved == null || saved.trim().isEmpty() ? DEFAULT_MESSAGE : saved.trim();
    }

    static void save(Context context, Boolean enabled, String message) {
        SharedPreferences.Editor editor = prefs(context).edit();
        if (enabled != null) editor.putBoolean("enabled", enabled);
        if (message != null) editor.putString("message", message.length() > 300 ? message.substring(0, 300) : message);
        editor.apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ------------------------------------------------------------------ state

    /** The ringing call, or null. */
    public static Ringing current() {
        Ringing value = ringing;
        if (value == null || System.currentTimeMillis() - value.at > RINGING_TTL_MS) return null;
        return value;
    }

    /** True while a call is active: driving mode stops listening so it does not hear the conversation. */
    public static boolean isInCall() {
        return inCall;
    }

    public static String simCountryIso(Context context) {
        TelephonyManager manager = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
        String iso = manager == null ? null : manager.getSimCountryIso();
        return iso == null || iso.isEmpty() ? "sa" : iso.toLowerCase(Locale.ROOT);
    }

    // ------------------------------------------------------------------ phone state (IncomingCallReceiver)

    static void onRinging(Context context, String number, BroadcastReceiver.PendingResult pending) {
        Context app = context.getApplicationContext();
        Ringing previous = ringing;
        if (number == null || number.isEmpty()
            || (previous != null && number.equals(previous.number) && System.currentTimeMillis() - previous.at < 30_000)) {
            finish(pending);
            return;
        }
        boolean driving = DrivingModeService.isRunning();
        if (!driving && !isEnabled(app)) {
            finish(pending);
            return;
        }
        String contact = contactName(app, number);
        String display = contact != null ? contact : spokenNumber(number);
        ringing = new Ringing(number, display, System.currentTimeMillis());
        showNotification(app, display, number);

        String announcement = "يتصل بك " + display + ".";
        if (driving) {
            DrivingModeService.announceCall(announcement + " قل: رد، أو ارفض، أو ارفض وقل له رسالتك.");
            finish(pending);
        } else {
            speak(app, announcement, pending);
        }
    }

    static void onOffHook(Context context) {
        inCall = true;
        clear(context);
    }

    static void onIdle(Context context) {
        inCall = false;
        clear(context);
    }

    private static void clear(Context context) {
        ringing = null;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(NOTIFICATION_ID);
        new Handler(Looper.getMainLooper()).post(() -> { if (tts != null) tts.stop(); });
    }

    // ------------------------------------------------------------------ actions

    /** Answers the ringing call (Android 8+, ANSWER_PHONE_CALLS). */
    @SuppressWarnings("MissingPermission")
    public static boolean answer(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !granted(context, Manifest.permission.ANSWER_PHONE_CALLS)) return false;
        TelecomManager telecom = (TelecomManager) context.getSystemService(Context.TELECOM_SERVICE);
        if (telecom == null) return false;
        try {
            telecom.acceptRingingCall();
            return true;
        } catch (SecurityException exception) {
            return false;
        }
    }

    /** Rejects the ringing call (Android 9+, ANSWER_PHONE_CALLS). */
    @SuppressWarnings({"MissingPermission", "deprecation"})
    public static boolean reject(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P || !granted(context, Manifest.permission.ANSWER_PHONE_CALLS)) return false;
        TelecomManager telecom = (TelecomManager) context.getSystemService(Context.TELECOM_SERVICE);
        if (telecom == null) return false;
        try {
            return telecom.endCall();
        } catch (SecurityException exception) {
            return false;
        }
    }

    static boolean granted(Context context, String permission) {
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED;
    }

    // ------------------------------------------------------------------ helpers

    private static String contactName(Context context, String number) {
        if (!granted(context, Manifest.permission.READ_CONTACTS)) return null;
        Uri uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number));
        try (Cursor cursor = context.getContentResolver().query(
            uri, new String[] { ContactsContract.PhoneLookup.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                return name == null || name.trim().isEmpty() ? null : name.trim();
            }
        } catch (RuntimeException ignored) {
            // Contacts provider unavailable: fall back to the number.
        }
        return null;
    }

    /** "رقم غير محفوظ ينتهي بـ ٤٥٦٧" — shorter to hear than the whole number. */
    private static String spokenNumber(String number) {
        String digits = number.replaceAll("\\D", "");
        if (digits.length() < 4) return "رقم غير معروف";
        return "رقم غير محفوظ ينتهي بـ " + digits.substring(digits.length() - 4);
    }

    private static void showNotification(Context context, String display, String number) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "مساعد المكالمات", NotificationManager.IMPORTANCE_HIGH));
        }
        int flags = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0) | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent answer = PendingIntent.getBroadcast(context, 41,
            new Intent(context, CallActionReceiver.class).setAction(CallActionReceiver.ACTION_ANSWER), flags);
        PendingIntent reject = PendingIntent.getBroadcast(context, 42,
            new Intent(context, CallActionReceiver.class).setAction(CallActionReceiver.ACTION_REJECT), flags);
        PendingIntent rejectWithMessage = PendingIntent.getActivity(context, 43,
            new Intent(context, CallMessageActivity.class)
                .putExtra(CallMessageActivity.EXTRA_NUMBER, number)
                .putExtra(CallMessageActivity.EXTRA_MESSAGE, message(context))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_HISTORY), flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL_ID)
            : new Notification.Builder(context);
        builder.setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle("يتصل بك " + display)
            .setContentText("Smart.z: رد أو ارفض من هنا")
            .setAutoCancel(true)
            .addAction(new Notification.Action.Builder(null, "رد", answer).build())
            .addAction(new Notification.Action.Builder(null, "رفض", reject).build())
            .addAction(new Notification.Action.Builder(null, "رفض برسالة", rejectWithMessage).build());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) builder.setTimeoutAfter(RINGING_TTL_MS);
        try {
            manager.notify(NOTIFICATION_ID, builder.build());
        } catch (SecurityException ignored) {
            // Notifications are off: the announcement still plays.
        }
    }

    /** Says who is calling with the phone's Arabic voice, then lets the receiver finish. */
    private static void speak(Context context, String text, BroadcastReceiver.PendingResult pending) {
        Handler main = new Handler(Looper.getMainLooper());
        Runnable done = () -> finish(pending);
        main.postDelayed(done, 8_000); // a receiver must finish within ~10 s
        main.post(() -> {
            if (tts != null) {
                tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "call");
                return;
            }
            tts = new TextToSpeech(context, status -> {
                if (status != TextToSpeech.SUCCESS || tts == null) return;
                tts.setLanguage(new Locale("ar"));
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { }
                    @Override public void onDone(String id) { main.removeCallbacks(done); main.post(done); }
                    @Override public void onError(String id) { main.removeCallbacks(done); main.post(done); }
                });
                tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "call");
            });
        });
    }

    private static void finish(BroadcastReceiver.PendingResult pending) {
        if (pending == null) return;
        try {
            pending.finish();
        } catch (IllegalStateException ignored) {
            // Already finished.
        }
    }
}
