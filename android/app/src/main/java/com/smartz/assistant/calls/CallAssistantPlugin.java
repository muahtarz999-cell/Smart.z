package com.smartz.assistant.calls;

import android.Manifest;
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

    private JSObject status() {
        JSObject result = new JSObject();
        result.put("enabled", CallAssistant.isEnabled(getContext()));
        result.put("message", getContext().getSharedPreferences(CallAssistant.PREFS, 0).getString("message", ""));
        result.put("callsPermission", getPermissionState("calls") == PermissionState.GRANTED);
        result.put("contactsPermission", getPermissionState("contacts") == PermissionState.GRANTED);
        return result;
    }
}
