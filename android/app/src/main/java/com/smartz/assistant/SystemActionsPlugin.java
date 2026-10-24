package com.smartz.assistant;

import android.Manifest;
import android.app.SearchManager;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.AlarmClock;
import android.provider.CalendarContract;
import android.provider.ContactsContract;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Phone system actions the assistant can run (lib/device-actions.js):
 * open any installed app, dial, SMS draft, alarm, timer, calendar event,
 * navigation, links, web search and settings. Calls and SMS only open the
 * dialer / composer: the user presses call or send.
 */
@CapacitorPlugin(
    name = "SystemActions",
    permissions = { @Permission(alias = "contacts", strings = { Manifest.permission.READ_CONTACTS }) }
)
public class SystemActionsPlugin extends Plugin {

    @PluginMethod
    public void perform(PluginCall call) {
        String action = call.getString("action", "");
        try {
            switch (action) {
                case "open_app": openApp(call); break;
                case "call":
                case "sms": dialOrMessage(call); break;
                case "alarm": setAlarm(call); break;
                case "timer": setTimer(call); break;
                case "calendar_event": addCalendarEvent(call); break;
                case "navigate": navigate(call); break;
                case "open_url": openUrl(call); break;
                case "web_search": webSearch(call); break;
                case "open_settings": openSettings(call); break;
                default: done(call, "إجراء غير مدعوم.");
            }
        } catch (ActivityNotFoundException exception) {
            done(call, "لا يوجد تطبيق على الهاتف يدعم هذا الإجراء.");
        } catch (SecurityException exception) {
            done(call, "النظام رفض هذا الإجراء.");
        }
    }

    private void done(PluginCall call, String message) {
        JSObject result = new JSObject();
        result.put("message", message == null ? "" : message);
        call.resolve(result);
    }

    private void start(Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
    }

    private void openApp(PluginCall call) {
        String name = call.getString("appName", "");
        String label = InstalledApps.launch(getContext(), name);
        if (label != null) {
            done(call, "");
            return;
        }
        try {
            start(new Intent(Intent.ACTION_VIEW, Uri.parse("market://search?q=" + Uri.encode(name))));
            done(call, "لم أجد «" + name + "» على الهاتف، فتحت المتجر للبحث عنه.");
        } catch (ActivityNotFoundException exception) {
            done(call, "لم أجد «" + name + "» على الهاتف.");
        }
    }

    // ------------------------------------------------------------ call / sms

    private static String digits(String value) {
        return value == null ? "" : value.replaceAll("[^\\d+]", "");
    }

    private void dialOrMessage(PluginCall call) {
        String recipient = call.getString("recipient", "").trim();
        String number = digits(recipient);
        if (number.replace("+", "").length() >= 6) {
            openDialOrMessage(call, number);
            return;
        }
        if (getPermissionState("contacts") != PermissionState.GRANTED) {
            requestPermissionForAlias("contacts", call, "contactsPermissionCallback");
            return;
        }
        resolveContactAndOpen(call, recipient);
    }

    @PermissionCallback
    private void contactsPermissionCallback(PluginCall call) {
        if (getPermissionState("contacts") != PermissionState.GRANTED) {
            done(call, "أحتاج إذن جهات الاتصال لأجد «" + call.getString("recipient", "") + "»، أو قل الرقم.");
            return;
        }
        resolveContactAndOpen(call, call.getString("recipient", "").trim());
    }

    private void resolveContactAndOpen(PluginCall call, String name) {
        Map<String, String> matches = findContacts(getContext(), name);
        if (matches.isEmpty()) {
            done(call, "ما لقيت «" + name + "» في جهات الاتصال.");
            return;
        }
        String exact = null;
        String wanted = InstalledApps.normalize(name);
        for (Map.Entry<String, String> entry : matches.entrySet()) {
            if (InstalledApps.normalize(entry.getKey()).equals(wanted)) exact = entry.getValue();
        }
        if (exact == null && matches.size() > 1) {
            done(call, "عندك أكثر من «" + name + "»: " + String.join("، ", matches.keySet()) + ". قل الاسم كاملًا.");
            return;
        }
        openDialOrMessage(call, exact != null ? exact : matches.values().iterator().next());
    }

    /** Display name → first phone number, for contacts whose name contains the spoken name. */
    private static Map<String, String> findContacts(Context context, String name) {
        Map<String, String> results = new LinkedHashMap<>();
        ContentResolver resolver = context.getContentResolver();
        String[] projection = {
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
        };
        try (Cursor cursor = resolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            projection,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?",
            new String[] { "%" + name + "%" },
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC")) {
            while (cursor != null && cursor.moveToNext() && results.size() < 6) {
                String display = cursor.getString(0);
                String number = cursor.getString(1);
                if (display != null && number != null && !results.containsKey(display)) results.put(display, digits(number));
            }
        }
        return results;
    }

    private void openDialOrMessage(PluginCall call, String number) {
        if ("call".equals(call.getString("action"))) {
            start(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(number))));
        } else {
            Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(number)));
            String message = call.getString("message", "");
            if (!message.isEmpty()) intent.putExtra("sms_body", message);
            start(intent);
        }
        done(call, "");
    }

    // ------------------------------------------------------------ clock / calendar

    private void setAlarm(PluginCall call) {
        Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, (int) call.getInt("hour", 7))
            .putExtra(AlarmClock.EXTRA_MINUTES, (int) call.getInt("minute", 0))
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        String label = call.getString("label", "");
        if (!label.isEmpty()) intent.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        start(intent);
        done(call, "");
    }

    private void setTimer(PluginCall call) {
        Intent intent = new Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, (int) call.getInt("seconds", 60))
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        String label = call.getString("label", "");
        if (!label.isEmpty()) intent.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        start(intent);
        done(call, "");
    }

    private void addCalendarEvent(PluginCall call) {
        Double startMillis = call.getDouble("startMillis");
        Double endMillis = call.getDouble("endMillis");
        Intent intent = new Intent(Intent.ACTION_INSERT)
            .setData(CalendarContract.Events.CONTENT_URI)
            .putExtra(CalendarContract.Events.TITLE, call.getString("title", ""));
        if (startMillis != null) intent.putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMillis.longValue());
        if (endMillis != null) intent.putExtra(CalendarContract.EXTRA_EVENT_END_TIME, endMillis.longValue());
        String location = call.getString("location", "");
        if (!location.isEmpty()) intent.putExtra(CalendarContract.Events.EVENT_LOCATION, location);
        start(intent);
        done(call, "");
    }

    // ------------------------------------------------------------ maps / web / settings

    private void navigate(PluginCall call) {
        String destination = call.getString("destination", "");
        try {
            start(new Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=" + Uri.encode(destination))));
        } catch (ActivityNotFoundException exception) {
            start(new Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(destination))));
        }
        done(call, "");
    }

    private void openUrl(PluginCall call) {
        Uri uri = Uri.parse(call.getString("url", ""));
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (!scheme.equals("https") && !scheme.equals("http")) {
            done(call, "الرابط غير صالح.");
            return;
        }
        start(new Intent(Intent.ACTION_VIEW, uri));
        done(call, "");
    }

    private void webSearch(PluginCall call) {
        String query = call.getString("query", "");
        try {
            start(new Intent(Intent.ACTION_WEB_SEARCH).putExtra(SearchManager.QUERY, query));
        } catch (ActivityNotFoundException exception) {
            start(new Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com/search?q=" + Uri.encode(query))));
        }
        done(call, "");
    }

    private void openSettings(PluginCall call) {
        String section = call.getString("section", "general");
        String action;
        switch (section) {
            case "wifi": action = Settings.ACTION_WIFI_SETTINGS; break;
            case "bluetooth": action = Settings.ACTION_BLUETOOTH_SETTINGS; break;
            case "display": action = Settings.ACTION_DISPLAY_SETTINGS; break;
            case "sound": action = Settings.ACTION_SOUND_SETTINGS; break;
            case "battery": action = Intent.ACTION_POWER_USAGE_SUMMARY; break;
            case "location": action = Settings.ACTION_LOCATION_SOURCE_SETTINGS; break;
            case "apps": action = Settings.ACTION_APPLICATION_SETTINGS; break;
            case "accessibility": action = Settings.ACTION_ACCESSIBILITY_SETTINGS; break;
            default: action = Settings.ACTION_SETTINGS;
        }
        try {
            start(new Intent(action));
        } catch (ActivityNotFoundException exception) {
            start(new Intent(Settings.ACTION_SETTINGS));
        }
        done(call, "");
    }
}
