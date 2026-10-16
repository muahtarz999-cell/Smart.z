package com.smartz.assistant.driving;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * Hands events from the service to the app's JavaScript (through
 * DrivingModePlugin). The service outlives the app screen; events marked
 * "retain" wait here until the app is open again (turns to add to the
 * conversation, sends that need a tap, why driving mode stopped).
 */
public final class DriveEvents {
    public interface Listener {
        void onDriveEvent(String name, JSONObject data, boolean retain);
    }

    private static final int MAX_PENDING = 100;
    private static Listener listener;
    private static final List<Object[]> pending = new ArrayList<>();

    private DriveEvents() { }

    public static synchronized void setListener(Listener next) {
        listener = next;
        if (next == null) return;
        List<Object[]> queued = new ArrayList<>(pending);
        pending.clear();
        for (Object[] event : queued) next.onDriveEvent((String) event[0], (JSONObject) event[1], true);
    }

    public static synchronized void clearListener(Listener current) {
        if (listener == current) listener = null;
    }

    static synchronized void emit(String name, JSONObject data, boolean retain) {
        if (listener != null) {
            listener.onDriveEvent(name, data, retain);
        } else if (retain) {
            if (pending.size() >= MAX_PENDING) pending.remove(0);
            pending.add(new Object[] { name, data });
        }
    }
}
