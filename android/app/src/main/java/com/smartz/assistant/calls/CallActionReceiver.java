package com.smartz.assistant.calls;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

/** The notification's «رد» and «رفض» buttons. */
public class CallActionReceiver extends BroadcastReceiver {
    static final String ACTION_ANSWER = "com.smartz.assistant.calls.ANSWER";
    static final String ACTION_REJECT = "com.smartz.assistant.calls.REJECT";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        boolean ok;
        if (ACTION_ANSWER.equals(action)) ok = CallAssistant.answer(context);
        else if (ACTION_REJECT.equals(action)) ok = CallAssistant.reject(context);
        else return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(CallAssistant.NOTIFICATION_ID);
        if (!ok) Toast.makeText(context, "اسمح لـ Smart.z بالتحكم في المكالمات من إعدادات «المكالمات»", Toast.LENGTH_LONG).show();
    }
}
