package com.smartz.assistant.calls;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * «رفض برسالة» from the notification: rejects the call, then opens a ready SMS
 * to the caller; the user presses send. An activity, because only a notification
 * tap may open another app's screen from the background.
 */
public class CallMessageActivity extends Activity {
    static final String EXTRA_NUMBER = "number";
    static final String EXTRA_MESSAGE = "message";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String number = getIntent().getStringExtra(EXTRA_NUMBER);
        String message = getIntent().getStringExtra(EXTRA_MESSAGE);
        CallAssistant.reject(this);
        if (number != null && !number.isEmpty()) {
            Intent sms = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(number)));
            sms.putExtra("sms_body", message == null ? CallAssistant.DEFAULT_MESSAGE : message);
            try {
                startActivity(sms);
            } catch (ActivityNotFoundException ignored) {
                // No SMS app: the call is still rejected.
            }
        }
        finish();
    }
}
