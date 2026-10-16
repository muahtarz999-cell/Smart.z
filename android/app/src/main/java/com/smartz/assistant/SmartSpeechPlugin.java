package com.smartz.assistant;

import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * The phone's own voice, replacing @capacitor-community/text-to-speech on Android (2026-10-16).
 *
 * Why: that plugin ignored the result of TextToSpeech.speak(), so a refused request never
 * answered (the app only saw "timed out"); it bound the engine once and never again, so an
 * engine updated or restarted by the system stayed dead; it used the default engine only;
 * and it could pick an Arabic voice whose data was not downloaded.
 *
 * Here: every request answers (done, a coded error, or ENGINE_SILENT when the engine never
 * starts); a refused request rebinds the engine and retries once; the engine is re-checked
 * when the app returns to the foreground (after installing voice data or updating apps); the
 * engine that actually has Arabic is chosen; voices whose data is not installed are skipped.
 * Same method names as the old plugin, so lib/tts.js keeps its flow.
 */
@CapacitorPlugin(name = "SmartSpeech")
public class SmartSpeechPlugin extends Plugin {

    private static final long BIND_TIMEOUT_MS = 5_000;
    private static final long START_TIMEOUT_MS = 8_000;
    private static final Locale ARABIC = Locale.forLanguageTag("ar");

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, PluginCall> pending = new ConcurrentHashMap<>();
    private final Set<String> started = Collections.newSetFromMap(new ConcurrentHashMap<>());

    private TextToSpeech tts;
    private String enginePackage;
    private volatile boolean ready = false;
    private String lastProblem = null;

    // ------------------------------------------------------------------ engine binding

    /** Binds one engine (null = the system default) and waits for its answer. Null when it does not come up. */
    private TextToSpeech bind(String packageName) {
        final CountDownLatch latch = new CountDownLatch(1);
        final int[] status = { TextToSpeech.ERROR };
        Context context = getContext();
        TextToSpeech.OnInitListener listener = (result) -> {
            status[0] = result;
            latch.countDown();
        };
        TextToSpeech engine = packageName == null
            ? new TextToSpeech(context, listener)
            : new TextToSpeech(context, listener, packageName);
        boolean answered;
        try {
            answered = latch.await(BIND_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            answered = false;
        }
        if (!answered || status[0] != TextToSpeech.SUCCESS) {
            try { engine.shutdown(); } catch (RuntimeException ignored) { }
            return null;
        }
        engine.setOnUtteranceProgressListener(progressListener);
        return engine;
    }

    private static boolean isInstalled(Voice voice) {
        Set<String> features = voice.getFeatures();
        return features == null || !features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED);
    }

    private static boolean isArabic(Voice voice) {
        return voice.getLocale() != null && "ar".equals(voice.getLocale().getLanguage());
    }

    /** Arabic is usable on this engine: the language is available and, when voices are listed, one is downloaded. */
    private static boolean hasArabic(TextToSpeech engine) {
        int availability;
        try {
            availability = engine.isLanguageAvailable(ARABIC);
        } catch (RuntimeException error) {
            return false;
        }
        if (availability < TextToSpeech.LANG_AVAILABLE) return false;
        Set<Voice> voices = safeVoices(engine);
        if (voices == null || voices.isEmpty()) return true;
        for (Voice voice : voices) {
            if (isArabic(voice) && isInstalled(voice)) return true;
        }
        return false;
    }

    private static Set<Voice> safeVoices(TextToSpeech engine) {
        try {
            return engine.getVoices();
        } catch (RuntimeException error) {
            return null;
        }
    }

    private synchronized void release() {
        ready = false;
        if (tts != null) {
            try { tts.stop(); tts.shutdown(); } catch (RuntimeException ignored) { }
        }
        tts = null;
        enginePackage = null;
    }

    /** Default engine first; when it has no Arabic, the first installed engine that does. */
    private synchronized boolean ensureReady(boolean rebind) {
        if (!rebind && ready && tts != null) return true;
        release();
        TextToSpeech fallback = bind(null);
        if (fallback == null) {
            lastProblem = "ENGINE_UNAVAILABLE";
            return false;
        }
        if (hasArabic(fallback)) {
            useEngine(fallback, fallback.getDefaultEngine());
            return true;
        }
        String defaultPackage = fallback.getDefaultEngine();
        List<TextToSpeech.EngineInfo> engines = fallback.getEngines();
        if (engines != null) {
            for (TextToSpeech.EngineInfo info : engines) {
                if (info.name == null || info.name.equals(defaultPackage)) continue;
                TextToSpeech candidate = bind(info.name);
                if (candidate == null) continue;
                if (hasArabic(candidate)) {
                    try { fallback.shutdown(); } catch (RuntimeException ignored) { }
                    useEngine(candidate, info.name);
                    return true;
                }
                try { candidate.shutdown(); } catch (RuntimeException ignored) { }
            }
        }
        // No engine has Arabic: keep the default so the error says exactly that.
        useEngine(fallback, defaultPackage);
        lastProblem = "NO_ARABIC";
        return true;
    }

    private void useEngine(TextToSpeech engine, String packageName) {
        tts = engine;
        enginePackage = packageName;
        ready = true;
        lastProblem = null;
    }

    /** Returning to the app (after installing voice data or updating apps): bind again on the next request. */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        ready = false;
    }

    @Override
    protected void handleOnDestroy() {
        finishAll(false);
        release();
        super.handleOnDestroy();
    }

    // ------------------------------------------------------------------ voices

    /** Downloaded voices only, in a stable order (the index the app sends refers to this list). */
    private List<Voice> installedVoices() {
        List<Voice> list = new ArrayList<>();
        Set<Voice> voices = tts == null ? null : safeVoices(tts);
        if (voices != null) {
            for (Voice voice : voices) {
                if (isInstalled(voice)) list.add(voice);
            }
        }
        list.sort((left, right) -> left.getName().compareTo(right.getName()));
        return list;
    }

    private static JSObject describe(Voice voice) {
        Locale locale = voice.getLocale();
        JSObject object = new JSObject();
        object.put("voiceURI", voice.getName());
        object.put("name", locale.getDisplayLanguage() + " " + locale.getDisplayCountry());
        object.put("lang", locale.toLanguageTag());
        object.put("localService", !voice.isNetworkConnectionRequired());
        object.put("default", false);
        return object;
    }

    @PluginMethod
    public void getSupportedVoices(PluginCall call) {
        if (!ensureReady(false)) {
            call.reject("لم يستجب محرك النطق في الجهاز. تأكد من تثبيت «خدمات Google للنطق» أو محرك نطق آخر.", "ENGINE_UNAVAILABLE");
            return;
        }
        JSArray voices = new JSArray();
        for (Voice voice : installedVoices()) voices.put(describe(voice));
        JSObject result = new JSObject();
        result.put("voices", voices);
        result.put("engine", enginePackage);
        call.resolve(result);
    }

    @PluginMethod
    public void isLanguageSupported(PluginCall call) {
        JSObject result = new JSObject();
        if (!ensureReady(false)) {
            result.put("supported", false);
        } else {
            int availability = tts.isLanguageAvailable(Locale.forLanguageTag(call.getString("lang", "ar")));
            result.put("supported", availability >= TextToSpeech.LANG_AVAILABLE);
        }
        call.resolve(result);
    }

    // ------------------------------------------------------------------ speaking

    private final UtteranceProgressListener progressListener = new UtteranceProgressListener() {
        @Override
        public void onStart(String utteranceId) {
            started.add(utteranceId);
        }

        @Override
        public void onDone(String utteranceId) {
            started.remove(utteranceId);
            PluginCall call = pending.remove(utteranceId);
            if (call != null) call.resolve();
        }

        @Override
        @Deprecated
        public void onError(String utteranceId) {
            onError(utteranceId, TextToSpeech.ERROR);
        }

        @Override
        public void onError(String utteranceId, int errorCode) {
            started.remove(utteranceId);
            PluginCall call = pending.remove(utteranceId);
            if (call == null) return;
            if (errorCode == TextToSpeech.ERROR_NOT_INSTALLED_YET) {
                call.reject("بيانات الصوت العربي لم تكتمل بعد على الجهاز. انتظر انتهاء التنزيل ثم أعد المحاولة.", "NOT_INSTALLED_YET");
            } else if (errorCode == TextToSpeech.ERROR_NETWORK || errorCode == TextToSpeech.ERROR_NETWORK_TIMEOUT) {
                call.reject("الصوت المختار يحتاج اتصالاً بالإنترنت.", "NETWORK");
            } else if (errorCode == TextToSpeech.ERROR_OUTPUT) {
                call.reject("تعذر إخراج الصوت. تحقق من صوت الوسائط أو سماعة Bluetooth.", "OUTPUT");
            } else {
                ready = false; // a broken engine is bound again on the next request
                call.reject("أبلغ محرك النطق عن خطأ (" + errorCode + "). أعد المحاولة.", "ENGINE_ERROR");
            }
        }

        @Override
        public void onStop(String utteranceId, boolean interrupted) {
            started.remove(utteranceId);
            PluginCall call = pending.remove(utteranceId);
            if (call != null) call.resolve();
        }
    };

    private Voice pickVoice(PluginCall call, Locale locale) {
        List<Voice> voices = installedVoices();
        String name = call.getString("voiceName", null);
        if (name != null) {
            for (Voice voice : voices) if (voice.getName().equals(name)) return voice;
        }
        Integer index = call.getInt("voice", -1);
        if (index != null && index >= 0 && index < voices.size() && isArabic(voices.get(index))) return voices.get(index);
        // Otherwise: an installed voice of the language, offline first.
        Voice best = null;
        for (Voice voice : voices) {
            if (!voice.getLocale().getLanguage().equals(locale.getLanguage())) continue;
            if (best == null || (best.isNetworkConnectionRequired() && !voice.isNetworkConnectionRequired())) best = voice;
        }
        return best;
    }

    /** One attempt. Returns null when the engine accepted the request, else the reason it did not. */
    private synchronized String trySpeak(PluginCall call, String id) {
        String text = call.getString("text", "");
        Locale locale = Locale.forLanguageTag(call.getString("lang", "ar"));

        int languageResult = tts.setLanguage(locale);
        if (languageResult == TextToSpeech.LANG_MISSING_DATA || languageResult == TextToSpeech.LANG_NOT_SUPPORTED) {
            if ("ar".equals(locale.getLanguage()) && tts.setLanguage(ARABIC) >= TextToSpeech.LANG_AVAILABLE) {
                locale = ARABIC;
            } else {
                return languageResult == TextToSpeech.LANG_MISSING_DATA ? "MISSING_DATA" : "NOT_SUPPORTED";
            }
        }
        Voice voice = pickVoice(call, locale);
        if (voice != null) tts.setVoice(voice);
        tts.setSpeechRate(call.getFloat("rate", 1.0f));
        tts.setPitch(call.getFloat("pitch", 1.0f));

        Bundle params = new Bundle();
        params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id);
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, call.getFloat("volume", 1.0f));
        int queue = call.getInt("queueStrategy", 0) == 1 ? TextToSpeech.QUEUE_ADD : TextToSpeech.QUEUE_FLUSH;
        pending.put(id, call);
        int result = tts.speak(text, queue, params, id);
        if (result != TextToSpeech.SUCCESS) {
            pending.remove(id);
            return "SPEAK_REFUSED";
        }
        return null;
    }

    @PluginMethod
    public void speak(PluginCall call) {
        if (call.getString("text", "").isEmpty()) {
            call.resolve();
            return;
        }
        if (!ensureReady(false)) {
            call.reject("لم يستجب محرك النطق في الجهاز. تأكد من تثبيت «خدمات Google للنطق» أو محرك نطق آخر.", "ENGINE_UNAVAILABLE");
            return;
        }
        if ("NO_ARABIC".equals(lastProblem)) {
            call.reject("لا يوجد صوت عربي مُنزَّل في أي محرك نطق على الجهاز. ثبّته من زر «تثبيت الصوت العربي».", "NO_ARABIC");
            return;
        }
        if (call.getInt("queueStrategy", 0) != 1) finishAll(true);

        String id = UUID.randomUUID().toString();
        String problem = trySpeak(call, id);
        if ("SPEAK_REFUSED".equals(problem)) {
            // The engine was restarted or updated under us: bind it again and retry once.
            if (ensureReady(true) && !"NO_ARABIC".equals(lastProblem)) problem = trySpeak(call, id);
        }
        if (problem != null) {
            reject(call, problem);
            return;
        }
        main.postDelayed(() -> {
            if (started.contains(id)) return;
            PluginCall silent = pending.remove(id);
            if (silent == null) return;
            ready = false;
            silent.reject("لم يبدأ محرك النطق «" + enginePackage + "» خلال 8 ثوانٍ. أعد المحاولة؛ وإن تكرر فاختر محرك Google في إعدادات النطق.", "ENGINE_SILENT");
        }, START_TIMEOUT_MS);
    }

    private void reject(PluginCall call, String problem) {
        switch (problem) {
            case "MISSING_DATA":
                call.reject("بيانات الصوت العربي غير مُنزَّلة في محرك النطق. ثبّتها من زر «تثبيت الصوت العربي».", problem);
                break;
            case "NOT_SUPPORTED":
                call.reject("محرك النطق في الجهاز لا يدعم العربية. ثبّت «خدمات Google للنطق».", problem);
                break;
            default:
                call.reject("رفض محرك النطق الطلب حتى بعد إعادة الربط. أعد تشغيل التطبيق أو الهاتف.", problem);
        }
    }

    /** Ends everything waiting: stopped speech answers "done", never silence. */
    private void finishAll(boolean resolve) {
        for (String id : new ArrayList<>(pending.keySet())) {
            PluginCall call = pending.remove(id);
            if (call == null) continue;
            if (resolve) call.resolve();
            else call.reject("توقف النطق.", "STOPPED");
        }
        started.clear();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) {
            try { tts.stop(); } catch (RuntimeException ignored) { }
        }
        finishAll(true);
        call.resolve();
    }

    // ------------------------------------------------------------------ diagnosis

    /** What the voice test shows when the phone's voice fails: where exactly it stops. */
    @PluginMethod
    public void diagnose(PluginCall call) {
        JSObject result = new JSObject();
        boolean bound = ensureReady(call.getBoolean("rebind", false));
        result.put("bound", bound);
        result.put("engine", enginePackage);
        result.put("problem", lastProblem);
        if (bound && tts != null) {
            result.put("defaultEngine", tts.getDefaultEngine());
            JSArray engines = new JSArray();
            List<TextToSpeech.EngineInfo> list = tts.getEngines();
            if (list != null) for (TextToSpeech.EngineInfo info : list) engines.put(info.name);
            result.put("engines", engines);
            result.put("arabicAvailability", tts.isLanguageAvailable(ARABIC));
            int installed = 0;
            int missing = 0;
            Set<Voice> voices = safeVoices(tts);
            if (voices != null) {
                for (Voice voice : voices) {
                    if (!isArabic(voice)) continue;
                    if (isInstalled(voice)) installed += 1; else missing += 1;
                }
            }
            result.put("arabicVoicesInstalled", installed);
            result.put("arabicVoicesNotDownloaded", missing);
        }
        call.resolve(result);
    }
}
