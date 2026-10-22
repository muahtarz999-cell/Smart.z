package com.smartz.assistant.screen;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.view.accessibility.AccessibilityNodeInfo;
import com.smartz.assistant.InstalledApps;
import com.smartz.assistant.R;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Runs one app-control task: read the screen → ask /api/phone-agent/step → act → repeat.
 * Runs on its own thread so it keeps going while another app is in front.
 * Safety: a hard step limit, a stop button in the notification, password fields are
 * never typed into or sent, and the server refuses payments/deletions (lib/phone-agent-step.js).
 */
public final class ScreenAgent implements Runnable {
    public static final String ACTION_STOP = "com.smartz.assistant.screen.STOP_AGENT";
    private static final String CHANNEL_ID = "smartz_screen_agent";
    private static final int NOTIFICATION_ID = 4711;
    private static final int MAX_STEPS = 25;
    private static final int MAX_NODES = 150;
    private static final int MAX_FAILED_REQUESTS = 3;

    /** Progress for the web app (ScreenControlPlugin → "progress" event). */
    public interface Listener {
        void onProgress(String status, String say, int step);
    }

    private static volatile ScreenAgent current;

    private final Context context;
    private final String goal;
    private final String appName;
    private final String baseUrl;
    private final String deviceId;
    private final Listener listener;
    private volatile String accessToken;
    private volatile boolean stopped;
    private final List<AccessibilityNodeInfo> nodes = new ArrayList<>();
    private final JSONArray history = new JSONArray();

    private ScreenAgent(Context context, String goal, String appName, String baseUrl, String accessToken, String deviceId, Listener listener) {
        this.context = context.getApplicationContext();
        this.goal = goal;
        this.appName = appName;
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.accessToken = accessToken;
        this.deviceId = deviceId;
        this.listener = listener;
    }

    public static synchronized void start(Context context, String goal, String appName, String baseUrl,
                                          String accessToken, String deviceId, Listener listener) {
        stopCurrent();
        current = new ScreenAgent(context, goal, appName, baseUrl, accessToken, deviceId, listener);
        Thread thread = new Thread(current, "smartz-screen-agent");
        thread.setDaemon(true);
        thread.start();
    }

    public static synchronized void stopCurrent() {
        ScreenAgent agent = current;
        if (agent != null) agent.stopped = true;
        current = null;
    }

    public static void updateToken(String token) {
        ScreenAgent agent = current;
        if (agent != null && token != null && !token.isEmpty()) agent.accessToken = token;
    }

    // ------------------------------------------------------------------ loop

    @Override
    public void run() {
        String finalStatus = "failed";
        String finalSay = "توقف التحكم.";
        int step = 0;
        try {
            report("running", "أبدأ: " + goal, 0);
            if (!appName.isEmpty()) {
                String label = InstalledApps.launch(context, appName);
                appendHistory("open_app", -1, appName, label != null, label != null ? "فتحت " + label : "لم أجد التطبيق");
                sleep(2200);
            }
            int failedRequests = 0;
            for (step = 0; step < MAX_STEPS; step++) {
                if (stopped) { finalStatus = "stopped"; finalSay = "أوقفت التحكم."; break; }
                SmartzAccessibilityService service = SmartzAccessibilityService.instance;
                if (service == null) { finalSay = "خدمة التحكم في التطبيقات غير مفعّلة."; break; }

                JSONObject screen = snapshot(service);
                JSONObject response = requestStep(screen, step);
                if (response == null) {
                    if (++failedRequests >= MAX_FAILED_REQUESTS) { finalSay = "تعذر الاتصال بالخادم."; break; }
                    sleep(1500);
                    step--;
                    continue;
                }
                failedRequests = 0;
                if (stopped) { finalStatus = "stopped"; finalSay = "أوقفت التحكم."; break; }

                JSONObject action = response.optJSONObject("action");
                if (action == null) { finalSay = "لم يصل رد صالح من الخادم."; break; }
                String kind = action.optString("action", "");
                String say = action.optString("say", "");
                if ("done".equals(kind)) { finalStatus = "done"; finalSay = say.isEmpty() ? "انتهيت." : say; break; }
                if ("need_user".equals(kind)) { finalStatus = "needs_user"; finalSay = say.isEmpty() ? "هذه الخطوة تحتاجك." : say; break; }

                if (!say.isEmpty()) report("running", say, step + 1);
                boolean ok = execute(service, action);
                appendHistory(kind, action.optInt("node", -1), action.optString("text", action.optString("appName", "")), ok, say);
                sleep("wait".equals(kind) ? 2500 : 1500);
            }
            if (step >= MAX_STEPS) { finalStatus = "needs_user"; finalSay = "وصلت للحد الأقصى من الخطوات. أكمل بنفسك."; }
        } catch (RuntimeException exception) {
            finalSay = "حدث خطأ أثناء التحكم في التطبيق.";
        } finally {
            nodes.clear();
            if (current == this) current = null;
            report(finalStatus, finalSay, step);
            cancelNotificationLater();
        }
    }

    private void appendHistory(String action, int node, String text, boolean ok, String say) {
        try {
            JSONObject item = new JSONObject().put("action", action).put("ok", ok);
            if (node >= 0) item.put("node", node);
            if (text != null && !text.isEmpty()) item.put("text", text.length() > 60 ? text.substring(0, 60) : text);
            if (say != null && !say.isEmpty()) item.put("say", say);
            history.put(item);
        } catch (JSONException ignored) { }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
        }
    }

    // ------------------------------------------------------------------ screen

    private JSONObject snapshot(AccessibilityService service) {
        nodes.clear();
        JSONObject screen = new JSONObject();
        JSONArray list = new JSONArray();
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        try {
            if (root != null) {
                screen.put("package", root.getPackageName() == null ? "" : root.getPackageName().toString());
                collect(root, list, 0);
            }
            screen.put("nodes", list);
        } catch (JSONException ignored) { }
        return screen;
    }

    private void collect(AccessibilityNodeInfo node, JSONArray list, int depth) throws JSONException {
        if (node == null || depth > 40 || nodes.size() >= MAX_NODES) return;
        if (node.isVisibleToUser()) {
            CharSequence text = node.getText();
            CharSequence description = node.getContentDescription();
            CharSequence hint = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? node.getHintText() : null;
            boolean password = node.isPassword();
            boolean useful = node.isClickable() || node.isEditable() || node.isScrollable() || node.isCheckable()
                || (text != null && text.length() > 0) || (description != null && description.length() > 0);
            if (useful) {
                JSONObject item = new JSONObject();
                item.put("i", nodes.size());
                // A password field is reported as such, never with its content.
                String shown = password ? "" : clip(text != null && text.length() > 0 ? text : hint);
                if (!shown.isEmpty()) item.put("t", shown);
                if (description != null && description.length() > 0) item.put("d", clip(description));
                String id = node.getViewIdResourceName();
                if (id != null) item.put("r", clip(id.substring(id.indexOf('/') + 1)));
                if (node.isClickable() || node.isCheckable()) item.put("c", 1);
                if (node.isEditable()) item.put("e", 1);
                if (node.isScrollable()) item.put("s", 1);
                if (password) item.put("p", 1);
                list.put(item);
                nodes.add(node);
            }
        }
        for (int index = 0; index < node.getChildCount() && nodes.size() < MAX_NODES; index++) {
            collect(node.getChild(index), list, depth + 1);
        }
    }

    private static String clip(CharSequence value) {
        if (value == null) return "";
        String text = value.toString().replaceAll("\\s+", " ").trim();
        return text.length() > 100 ? text.substring(0, 100) : text;
    }

    // ------------------------------------------------------------------ actions

    private boolean execute(AccessibilityService service, JSONObject action) {
        String kind = action.optString("action", "");
        switch (kind) {
            case "tap": return tap(service, nodeAt(action.optInt("node", -1)));
            case "type": return type(nodeAt(action.optInt("node", -1)), action.optString("text", ""), action.optBoolean("submit", false));
            case "scroll": return scroll(service, !"up".equals(action.optString("direction", "down")));
            case "back": return service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK);
            case "home": return service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME);
            case "open_app": return InstalledApps.launch(context, action.optString("appName", "")) != null;
            case "wait": return true;
            default: return false;
        }
    }

    private AccessibilityNodeInfo nodeAt(int index) {
        return index >= 0 && index < nodes.size() ? nodes.get(index) : null;
    }

    private boolean tap(AccessibilityService service, AccessibilityNodeInfo node) {
        if (node == null) return false;
        AccessibilityNodeInfo target = node;
        for (int level = 0; level < 6 && target != null; level++) {
            if (target.isClickable() && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
            target = target.getParent();
        }
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        if (bounds.isEmpty()) return false;
        Path path = new Path();
        path.moveTo(bounds.exactCenterX(), bounds.exactCenterY());
        return gesture(service, path, 60);
    }

    private boolean type(AccessibilityNodeInfo node, String text, boolean submit) {
        if (node == null || node.isPassword() || text.isEmpty()) return false;
        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        Bundle arguments = new Bundle();
        arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        boolean ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
        if (ok && submit && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
        }
        return ok;
    }

    private boolean scroll(AccessibilityService service, boolean down) {
        for (AccessibilityNodeInfo node : nodes) {
            if (node.isScrollable() && node.performAction(down
                ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
                : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)) {
                return true;
            }
        }
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        float x = metrics.widthPixels / 2f;
        float top = metrics.heightPixels * 0.3f;
        float bottom = metrics.heightPixels * 0.7f;
        Path path = new Path();
        path.moveTo(x, down ? bottom : top);
        path.lineTo(x, down ? top : bottom);
        return gesture(service, path, 350);
    }

    private static boolean gesture(AccessibilityService service, Path path, long durationMs) {
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, durationMs))
            .build();
        return service.dispatchGesture(gesture, null, null);
    }

    // ------------------------------------------------------------------ server

    private JSONObject requestStep(JSONObject screen, int step) {
        HttpURLConnection connection = null;
        try {
            JSONObject body = new JSONObject()
                .put("goal", goal)
                .put("appName", appName)
                .put("step", step)
                .put("screen", screen)
                .put("history", history);
            connection = (HttpURLConnection) new URL(baseUrl + "/api/phone-agent/step").openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(45_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + accessToken);
            if (deviceId != null && !deviceId.isEmpty()) connection.setRequestProperty("X-Smartz-Device", deviceId);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) return null;
            try (InputStream in = connection.getInputStream()) {
                return new JSONObject(readAll(in));
            }
        } catch (IOException | JSONException exception) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = in.read(chunk)) != -1) {
            buffer.write(chunk, 0, read);
            if (buffer.size() > 64 * 1024) throw new IOException("response too large");
        }
        return buffer.toString("UTF-8");
    }

    // ------------------------------------------------------------------ progress

    private void report(String status, String say, int step) {
        showNotification(status, say);
        if (listener != null) {
            try {
                listener.onProgress(status, say, step);
            } catch (RuntimeException ignored) {
                // The web app may be gone; the notification still shows progress.
            }
        }
    }

    private void showNotification(String status, String say) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                new NotificationChannel(CHANNEL_ID, "التحكم في التطبيقات", NotificationManager.IMPORTANCE_LOW));
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL_ID)
            : new Notification.Builder(context);
        builder.setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle("running".equals(status) ? "Smart.z يتحكم في الهاتف" : "Smart.z")
            .setContentText(say)
            .setStyle(new Notification.BigTextStyle().bigText(say))
            .setOnlyAlertOnce(true)
            .setOngoing("running".equals(status));
        if ("running".equals(status)) {
            int immutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;
            Intent stop = new Intent(ACTION_STOP).setPackage(context.getPackageName());
            PendingIntent stopIntent = PendingIntent.getBroadcast(context, 7, stop, immutable | PendingIntent.FLAG_UPDATE_CURRENT);
            builder.addAction(new Notification.Action.Builder(null, "إيقاف", stopIntent).build());
        }
        try {
            manager.notify(NOTIFICATION_ID, builder.build());
        } catch (SecurityException ignored) {
            // Notifications not allowed: the agent still runs; the web app shows progress.
        }
    }

    private void cancelNotificationLater() {
        new Thread(() -> {
            sleep(15_000);
            if (current == null) {
                NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
                if (manager != null) manager.cancel(NOTIFICATION_ID);
            }
        }, "smartz-agent-cleanup").start();
    }
}
