package com.smartz.assistant.driving;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.os.Build;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;

/**
 * The small round bubble drawn over Maps or any other app while driving mode
 * runs in the background. It pulses with the microphone level and the
 * assistant's voice. Tap: stop the assistant talking. Drag to the red target
 * at the bottom: end driving mode. Needs "Display over other apps"; without
 * it driving mode still works, just without the bubble.
 */
final class BubbleOverlay {
    interface Actions {
        void onBubbleTap();
        void onBubbleDismiss();
    }

    private static final int GOLD = Color.rgb(0xC9, 0xA8, 0x68);
    private static final int GOLD_LIGHT = Color.rgb(0xF0, 0xD4, 0x8A);
    private static final int DARK = Color.rgb(0x0B, 0x0D, 0x12);

    private final Context context;
    private final WindowManager windowManager;
    private final Actions actions;
    private final float density;
    private BubbleView bubble;
    private TargetView target;
    private WindowManager.LayoutParams bubbleParams;
    private WindowManager.LayoutParams targetParams;

    BubbleOverlay(Context context, Actions actions) {
        this.context = context.getApplicationContext();
        this.windowManager = (WindowManager) this.context.getSystemService(Context.WINDOW_SERVICE);
        this.actions = actions;
        this.density = this.context.getResources().getDisplayMetrics().density;
    }

    static boolean canDraw(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context);
    }

    boolean isShown() {
        return bubble != null;
    }

    /** Main thread only. */
    void show() {
        if (bubble != null || !canDraw(context)) return;
        int size = dp(68);
        bubble = new BubbleView(context);
        bubbleParams = params(size, size, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);
        bubbleParams.gravity = Gravity.TOP | Gravity.START;
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        bubbleParams.x = metrics.widthPixels - size - dp(12);
        bubbleParams.y = metrics.heightPixels / 3;
        attachTouch();
        try {
            windowManager.addView(bubble, bubbleParams);
        } catch (RuntimeException error) {
            bubble = null; // permission revoked meanwhile
        }
    }

    /** Main thread only. */
    void hide() {
        hideTarget();
        if (bubble == null) return;
        try { windowManager.removeView(bubble); } catch (RuntimeException ignored) { }
        bubble = null;
    }

    /** phase: listening | thinking | speaking. Any thread. */
    void update(String phase, float level) {
        BubbleView view = bubble;
        if (view == null) return;
        view.phase = phase;
        view.level = level;
        view.postInvalidate();
    }

    private WindowManager.LayoutParams params(int width, int height, int flags) {
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
        return new WindowManager.LayoutParams(width, height, type, flags, PixelFormat.TRANSLUCENT);
    }

    @SuppressLint("ClickableViewAccessibility")
    private void attachTouch() {
        final float[] down = new float[4];
        final long[] downAt = new long[1];
        final boolean[] dragging = new boolean[1];
        bubble.setOnTouchListener((view, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    down[0] = event.getRawX();
                    down[1] = event.getRawY();
                    down[2] = bubbleParams.x;
                    down[3] = bubbleParams.y;
                    downAt[0] = event.getEventTime();
                    dragging[0] = false;
                    return true;
                case MotionEvent.ACTION_MOVE: {
                    float dx = event.getRawX() - down[0];
                    float dy = event.getRawY() - down[1];
                    if (!dragging[0] && Math.hypot(dx, dy) > dp(10)) {
                        dragging[0] = true;
                        showTarget();
                    }
                    if (dragging[0]) {
                        bubbleParams.x = (int) (down[2] + dx);
                        bubbleParams.y = (int) (down[3] + dy);
                        try { windowManager.updateViewLayout(bubble, bubbleParams); } catch (RuntimeException ignored) { }
                        if (target != null) target.active = overTarget(event.getRawY());
                        if (target != null) target.invalidate();
                    }
                    return true;
                }
                case MotionEvent.ACTION_UP:
                    if (dragging[0]) {
                        boolean dismiss = overTarget(event.getRawY());
                        hideTarget();
                        if (dismiss) actions.onBubbleDismiss();
                    } else if (event.getEventTime() - downAt[0] < 400) {
                        actions.onBubbleTap();
                    }
                    return true;
                case MotionEvent.ACTION_CANCEL:
                    hideTarget();
                    return true;
                default:
                    return false;
            }
        });
    }

    private boolean overTarget(float rawY) {
        return rawY > context.getResources().getDisplayMetrics().heightPixels * 0.85f;
    }

    private void showTarget() {
        if (target != null) return;
        target = new TargetView(context);
        targetParams = params(dp(84), dp(84), WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
        targetParams.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        targetParams.y = dp(36);
        try {
            windowManager.addView(target, targetParams);
        } catch (RuntimeException error) {
            target = null;
        }
    }

    private void hideTarget() {
        if (target == null) return;
        try { windowManager.removeView(target); } catch (RuntimeException ignored) { }
        target = null;
    }

    private int dp(int value) {
        return Math.round(value * density);
    }

    private static final class BubbleView extends View {
        volatile String phase = "listening";
        volatile float level = 0;
        private float shown = 0;
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);

        BubbleView(Context context) {
            super(context);
            ring.setStyle(Paint.Style.STROKE);
            setContentDescription("Smart.z — وضع القيادة");
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float w = getWidth();
            float cx = w / 2f;
            float cy = getHeight() / 2f;
            long now = System.currentTimeMillis();
            float targetLevel;
            if ("speaking".equals(phase)) targetLevel = 0.55f + 0.3f * (float) Math.sin(now / 160.0);
            else if ("thinking".equals(phase)) targetLevel = 0.25f + 0.15f * (float) Math.sin(now / 380.0);
            else targetLevel = Math.min(1f, level * 1.6f);
            shown += (targetLevel - shown) * 0.25f;

            float core = w * 0.30f;
            fill.setColor(DARK);
            canvas.drawCircle(cx, cy, w * 0.46f, fill);
            ring.setStrokeWidth(w * 0.05f);
            ring.setColor("speaking".equals(phase) ? GOLD_LIGHT : GOLD);
            ring.setAlpha(110 + (int) (145 * Math.max(0, Math.min(1, shown))));
            canvas.drawCircle(cx, cy, core + (w * 0.13f) * shown, ring);
            fill.setColor("speaking".equals(phase) ? GOLD_LIGHT : GOLD);
            canvas.drawCircle(cx, cy, core * 0.55f, fill);
            if (!"listening".equals(phase) || shown > 0.02f) postInvalidateOnAnimation();
        }
    }

    private static final class TargetView extends View {
        volatile boolean active = false;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        TargetView(Context context) {
            super(context);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float w = getWidth();
            float c = w / 2f;
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(active ? Color.rgb(0xEF, 0x44, 0x44) : Color.argb(200, 0x7F, 0x1D, 0x1D));
            canvas.drawCircle(c, c, w * (active ? 0.48f : 0.42f), paint);
            paint.setColor(Color.WHITE);
            paint.setStrokeWidth(w * 0.07f);
            paint.setStrokeCap(Paint.Cap.ROUND);
            float d = w * 0.14f;
            canvas.drawLine(c - d, c - d, c + d, c + d, paint);
            canvas.drawLine(c + d, c - d, c - d, c + d, paint);
        }
    }
}
