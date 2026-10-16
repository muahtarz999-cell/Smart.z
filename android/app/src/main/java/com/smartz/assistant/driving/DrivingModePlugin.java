package com.smartz.assistant.driving;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * JavaScript ↔ driving-mode service (lib/driving-mode.js).
 *
 *   start(context)            starts the foreground service (call while the app is on screen)
 *   stop({ reason, announce })
 *   interrupt()               stop the assistant talking
 *   updateSession({ accessToken, expiresAt })
 *   status()                  { active }
 *   checkOverlayPermission() / requestOverlayPermission()   { granted }
 *
 * Events: state { phase, level? } · turn { transcript, reply } · action { action }
 *         needsToken · stopped { reason, message? }
 */
@CapacitorPlugin(name = "DrivingMode")
public class DrivingModePlugin extends Plugin implements DriveEvents.Listener {
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        DriveEvents.setListener(this);
    }

    @Override
    protected void handleOnResume() {
        DrivingModeService.setAppVisible(true);
    }

    @Override
    protected void handleOnPause() {
        DrivingModeService.setAppVisible(false);
    }

    @Override
    protected void handleOnDestroy() {
        DriveEvents.clearListener(this);
        DrivingModeService.setAppVisible(false);
    }

    @Override
    public void onDriveEvent(String name, JSONObject data, boolean retain) {
        main.post(() -> {
            try {
                notifyListeners(name, JSObject.fromJSONObject(data), retain);
            } catch (JSONException ignored) {
                // events are built from valid JSON
            }
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            call.reject("اسمح للتطبيق باستخدام الميكروفون أولاً.", "MIC_PERMISSION");
            return;
        }
        JSObject data = call.getData();
        String baseUrl = data.getString("baseUrl", "");
        String token = data.getString("accessToken", "");
        if (baseUrl == null || baseUrl.isEmpty() || token == null || token.isEmpty()) {
            call.reject("بيانات الدخول غير مكتملة.", "BAD_CONTEXT");
            return;
        }
        try {
            DrivingModeService.setAppVisible(true);
            DrivingModeService.start(getContext(), new JSONObject(data.toString()));
            call.resolve();
        } catch (JSONException | RuntimeException error) {
            call.reject("تعذر تشغيل وضع القيادة في الخلفية.", "START_FAILED", error);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        DrivingModeService.requestStop(call.getString("reason", "user"), Boolean.TRUE.equals(call.getBoolean("announce", true)));
        call.resolve();
    }

    @PluginMethod
    public void interrupt(PluginCall call) {
        DrivingModeService.interruptSpeech();
        call.resolve();
    }

    @PluginMethod
    public void updateSession(PluginCall call) {
        // optLong accepts any JSON number (JavaScript sends large integers as Long or Double).
        DrivingModeService.updateSession(call.getString("accessToken"), call.getData().optLong("expiresAt", 0));
        call.resolve();
    }

    /** Fresh context from the app while driving (e.g. the WhatsApp messages stored on the phone). */
    @PluginMethod
    public void updateContext(PluginCall call) {
        try {
            DrivingModeService.updateContext(new JSONObject(call.getData().toString()));
        } catch (JSONException ignored) {
            // nothing to merge
        }
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("active", DrivingModeService.isRunning());
        call.resolve(result);
    }

    @PluginMethod
    public void checkOverlayPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", BubbleOverlay.canDraw(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        if (BubbleOverlay.canDraw(getContext()) || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            checkOverlayPermission(call);
            return;
        }
        Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
        try {
            startActivityForResult(call, intent, "onOverlayResult");
        } catch (RuntimeException error) {
            call.reject("تعذر فتح إعداد الظهور فوق التطبيقات.");
        }
    }

    @ActivityCallback
    private void onOverlayResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        checkOverlayPermission(call);
    }
}
