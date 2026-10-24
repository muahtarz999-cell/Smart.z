package com.smartz.assistant.calls;

import android.Manifest;
import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CallLog;
import android.provider.ContactsContract;
import android.provider.Telephony;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** Web side: lib/call-assistant.js and components/CallSettings.jsx. */
@CapacitorPlugin(
    name = "CallAssistant",
    permissions = {
        @Permission(alias = "calls", strings = {
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.ANSWER_PHONE_CALLS,
        }),
        @Permission(alias = "contacts", strings = { Manifest.permission.READ_CONTACTS }),
        @Permission(alias = "sms", strings = { Manifest.permission.READ_SMS }),
    }
)
public class CallAssistantPlugin extends Plugin {

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void setSettings(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        String message = call.getString("message");
        CallAssistant.save(getContext(), enabled, message);
        call.resolve(status());
    }

    @PluginMethod
    public void requestCallPermissions(PluginCall call) {
        if (getPermissionState("calls") == PermissionState.GRANTED && getPermissionState("contacts") == PermissionState.GRANTED) {
            call.resolve(status());
            return;
        }
        requestPermissionForAliases(new String[] { "calls", "contacts" }, call, "permissionsCallback");
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        call.resolve(status());
    }

    // ------------------------------------------------------------ day summary (on request only)

    /** Asked the first time the user requests «لخّص يومي». */
    @PluginMethod
    public void requestSummaryPermissions(PluginCall call) {
        if (getPermissionState("calls") == PermissionState.GRANTED && getPermissionState("contacts") == PermissionState.GRANTED
                && getPermissionState("sms") == PermissionState.GRANTED) {
            call.resolve(status());
            return;
        }
        requestPermissionForAliases(new String[] { "calls", "contacts", "sms" }, call, "permissionsCallback");
    }

    /** Call log between from and to (ms): name, number, type, duration (s), date. */
    @PluginMethod
    public void getRecentCalls(PluginCall call) {
        if (getPermissionState("calls") != PermissionState.GRANTED) {
            call.reject("no-permission");
            return;
        }
        long from = call.getLong("from", 0L);
        long to = call.getLong("to", System.currentTimeMillis() + 1);
        JSArray items = new JSArray();
        String[] columns = { CallLog.Calls.CACHED_NAME, CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DURATION, CallLog.Calls.DATE };
        try (Cursor cursor = getContext().getContentResolver().query(CallLog.Calls.CONTENT_URI, columns,
                CallLog.Calls.DATE + " >= ? AND " + CallLog.Calls.DATE + " < ?",
                new String[] { String.valueOf(from), String.valueOf(to) }, CallLog.Calls.DATE + " DESC")) {
            int count = 0;
            while (cursor != null && cursor.moveToNext() && count++ < 120) {
                JSObject item = new JSObject();
                item.put("name", cursor.getString(0));
                item.put("number", cursor.getString(1));
                item.put("type", callType(cursor.getInt(2)));
                item.put("duration", cursor.getLong(3));
                item.put("date", cursor.getLong(4));
                items.put(item);
            }
        } catch (Exception error) {
            call.reject("call-log-unavailable");
            return;
        }
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }

    /** Received SMS between from and to (ms): address, contact name, body, date. */
    @PluginMethod
    public void getRecentSms(PluginCall call) {
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            call.reject("no-permission");
            return;
        }
        long from = call.getLong("from", 0L);
        long to = call.getLong("to", System.currentTimeMillis() + 1);
        boolean contacts = getPermissionState("contacts") == PermissionState.GRANTED;
        JSArray items = new JSArray();
        ContentResolver resolver = getContext().getContentResolver();
        String[] columns = { Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE };
        try (Cursor cursor = resolver.query(Telephony.Sms.Inbox.CONTENT_URI, columns,
                Telephony.Sms.DATE + " >= ? AND " + Telephony.Sms.DATE + " < ?",
                new String[] { String.valueOf(from), String.valueOf(to) }, Telephony.Sms.DATE + " DESC")) {
            int count = 0;
            while (cursor != null && cursor.moveToNext() && count++ < 120) {
                String address = cursor.getString(0);
                JSObject item = new JSObject();
                item.put("address", address);
                item.put("name", contacts ? contactName(resolver, address) : null);
                item.put("body", cursor.getString(1));
                item.put("date", cursor.getLong(2));
                items.put(item);
            }
        } catch (Exception error) {
            call.reject("sms-unavailable");
            return;
        }
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }

    private static String callType(int type) {
        switch (type) {
            case CallLog.Calls.MISSED_TYPE: return "missed";
            case CallLog.Calls.OUTGOING_TYPE: return "outgoing";
            case CallLog.Calls.REJECTED_TYPE:
            case CallLog.Calls.BLOCKED_TYPE: return "rejected";
            default: return "incoming";
        }
    }

    private static String contactName(ContentResolver resolver, String number) {
        if (number == null || number.isEmpty()) return null;
        Uri uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number));
        try (Cursor cursor = resolver.query(uri, new String[] { ContactsContract.PhoneLookup.DISPLAY_NAME }, null, null, null)) {
            return cursor != null && cursor.moveToFirst() ? cursor.getString(0) : null;
        } catch (Exception error) {
            return null;
        }
    }

    private JSObject status() {
        JSObject result = new JSObject();
        result.put("enabled", CallAssistant.isEnabled(getContext()));
        result.put("message", getContext().getSharedPreferences(CallAssistant.PREFS, 0).getString("message", ""));
        result.put("callsPermission", getPermissionState("calls") == PermissionState.GRANTED);
        result.put("contactsPermission", getPermissionState("contacts") == PermissionState.GRANTED);
        result.put("smsPermission", getPermissionState("sms") == PermissionState.GRANTED);
        return result;
    }
}
