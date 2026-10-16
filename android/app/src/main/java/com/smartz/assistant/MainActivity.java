package com.smartz.assistant;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.smartz.assistant.driving.DrivingModePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NotificationSettingsPlugin.class);
        registerPlugin(SpeechEngineSetupPlugin.class);
        registerPlugin(SmartSpeechPlugin.class);
        registerPlugin(DrivingModePlugin.class);
        super.onCreate(savedInstanceState);

        // The web app records the menu and its sections as history entries:
        // the phone's back button steps back through them before leaving.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }
}
