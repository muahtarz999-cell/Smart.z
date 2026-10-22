package com.smartz.assistant.screen;

import android.accessibilityservice.AccessibilityService;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.view.accessibility.AccessibilityEvent;
import androidx.core.content.ContextCompat;

/**
 * «Smart.z — التحكم في التطبيقات». The user turns it on in the system accessibility
 * settings; nothing happens until the assistant starts a ScreenAgent, and the
 * agent's notification can stop it at any time. It does not read the screen
 * on its own: screens are read only while an agent task runs.
 */
public class SmartzAccessibilityService extends AccessibilityService {
    static volatile SmartzAccessibilityService instance;

    private final BroadcastReceiver stopReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            ScreenAgent.stopCurrent();
        }
    };

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        ContextCompat.registerReceiver(
            this, stopReceiver, new IntentFilter(ScreenAgent.ACTION_STOP), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Screens are read on demand by ScreenAgent; events are not stored or sent anywhere.
    }

    @Override
    public void onInterrupt() { }

    @Override
    public void onDestroy() {
        ScreenAgent.stopCurrent();
        try {
            unregisterReceiver(stopReceiver);
        } catch (IllegalArgumentException ignored) {
            // Not registered (service never connected).
        }
        if (instance == this) instance = null;
        super.onDestroy();
    }

    /** True when the user enabled the service and it is connected. */
    public static boolean isRunning() {
        return instance != null;
    }
}
