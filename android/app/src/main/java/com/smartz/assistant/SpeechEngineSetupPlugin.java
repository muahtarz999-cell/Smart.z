package com.smartz.assistant;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.speech.tts.TextToSpeech;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SpeechEngineSetup")
public class SpeechEngineSetupPlugin extends Plugin {
    @PluginMethod
    public void openInstall(PluginCall call) {
        Intent installIntent = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
        if (canResolve(installIntent)) {
            startActivityForResult(call, installIntent, "onInstallActivityResult");
            return;
        }

        Intent settingsIntent = new Intent("android.settings.TTS_SETTINGS");
        if (canResolve(settingsIntent)) {
            startActivityForResult(call, settingsIntent, "onSettingsActivityResult");
            return;
        }

        call.reject("لم يعثر Android على شاشة لتثبيت بيانات النطق أو إعداد محرك تحويل النص إلى كلام.");
    }

    @ActivityCallback
    private void onInstallActivityResult(PluginCall call, ActivityResult result) {
        resolveActivityResult(call, "install", result);
    }

    @ActivityCallback
    private void onSettingsActivityResult(PluginCall call, ActivityResult result) {
        resolveActivityResult(call, "settings", result);
    }

    private boolean canResolve(Intent intent) {
        return getContext().getPackageManager().resolveActivity(
            intent,
            PackageManager.MATCH_DEFAULT_ONLY
        ) != null;
    }

    private void resolveActivityResult(PluginCall call, String action, ActivityResult result) {
        if (call == null) return;

        JSObject response = new JSObject();
        response.put("action", action);
        response.put("resultCode", result.getResultCode());
        call.resolve(response);
    }
}
