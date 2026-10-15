package com.smartz.assistant;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.smartz.assistant.driving.DrivingModePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NotificationSettingsPlugin.class);
        registerPlugin(SpeechEngineSetupPlugin.class);
        registerPlugin(DrivingModePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
