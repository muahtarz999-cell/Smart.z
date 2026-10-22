package com.smartz.assistant.screen;

import android.content.ComponentName;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.text.TextUtils;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Web side of app control: lib/phone-agent.js. */
@CapacitorPlugin(name = "ScreenControl")
public class ScreenControlPlugin extends Plugin {

    @PluginMethod
    public void isEnabled(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", SmartzAccessibilityService.isRunning() || enabledInSettings());
        call.resolve(result);
    }

    private boolean enabledInSettings() {
        String enabled = Settings.Secure.getString(
            getContext().getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(enabled)) return false;
        String ours = new ComponentName(getContext(), SmartzAccessibilityService.class).flattenToString();
        for (String service : enabled.split(":")) {
            if (service.equalsIgnoreCase(ours)) return true;
        }
        return false;
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        String goal = call.getString("goal", "").trim();
        String baseUrl = call.getString("baseUrl", "");
        String token = call.getString("accessToken", "");
        if (goal.isEmpty() || token.isEmpty()) {
            call.reject("goal and accessToken are required");
            return;
        }
        Uri base = Uri.parse(baseUrl);
        boolean secure = "https".equalsIgnoreCase(base.getScheme())
            || ("http".equalsIgnoreCase(base.getScheme()) && ("localhost".equals(base.getHost()) || "10.0.2.2".equals(base.getHost())));
        if (!secure || base.getHost() == null) {
            call.reject("baseUrl must be https");
            return;
        }
        if (!SmartzAccessibilityService.isRunning()) {
            call.reject("accessibility service is not enabled");
            return;
        }
        ScreenAgent.start(
            getContext(),
            goal.length() > 500 ? goal.substring(0, 500) : goal,
            call.getString("appName", ""),
            baseUrl,
            token,
            call.getString("deviceId", ""),
            (status, say, step) -> {
                JSObject event = new JSObject();
                event.put("status", status);
                event.put("say", say);
                event.put("step", step);
                notifyListeners("progress", event);
            });
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ScreenAgent.stopCurrent();
        call.resolve();
    }

    @PluginMethod
    public void updateToken(PluginCall call) {
        ScreenAgent.updateToken(call.getString("accessToken", ""));
        call.resolve();
    }
}
