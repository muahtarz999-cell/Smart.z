package com.smartz.assistant.calls;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.telephony.TelephonyManager;

/**
 * Phone state from the system (needs READ_PHONE_STATE; the caller's number also
 * needs READ_CALL_LOG). Android sends RINGING twice, once without the number:
 * only the one with the number is used.
 */
public class IncomingCallReceiver extends BroadcastReceiver {
    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context context, Intent intent) {
        if (!TelephonyManager.ACTION_PHONE_STATE_CHANGED.equals(intent.getAction())) return;
        String state = intent.getStringExtra(TelephonyManager.EXTRA_STATE);
        if (TelephonyManager.EXTRA_STATE_RINGING.equals(state)) {
            String number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER);
            if (number == null || number.isEmpty()) return;
            CallAssistant.onRinging(context, number, goAsync());
        } else if (TelephonyManager.EXTRA_STATE_OFFHOOK.equals(state)) {
            CallAssistant.onOffHook(context);
        } else if (TelephonyManager.EXTRA_STATE_IDLE.equals(state)) {
            CallAssistant.onIdle(context);
        }
    }
}
