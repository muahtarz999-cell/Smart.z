package com.smartz.assistant;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Finds an installed app by the name the user said (Arabic or English label, or a known alias). */
public final class InstalledApps {
    private InstalledApps() { }

    /** Spoken Arabic names → words that appear in the English label or the package name. */
    private static final Map<String, String> ALIASES = new HashMap<>();

    static {
        String[][] pairs = {
            {"يوتيوب", "youtube"}, {"واتساب", "whatsapp"}, {"واتس", "whatsapp"}, {"انستقرام", "instagram"},
            {"انستغرام", "instagram"}, {"سناب", "snapchat"}, {"سناب شات", "snapchat"}, {"تويتر", "twitter"},
            {"اكس", "twitter"}, {"تيك توك", "tiktok"}, {"تيكتوك", "tiktok"}, {"فيسبوك", "facebook"},
            {"تلقرام", "telegram"}, {"تيليجرام", "telegram"}, {"كروم", "chrome"}, {"المتصفح", "chrome"},
            {"جيميل", "gmail"}, {"البريد", "gmail"}, {"الخرائط", "maps"}, {"خرائط قوقل", "maps"},
            {"قوقل", "google"}, {"جوجل", "google"}, {"الكاميرا", "camera"}, {"الكامرا", "camera"},
            {"الاعدادات", "settings"}, {"الإعدادات", "settings"}, {"الحاسبة", "calculator"},
            {"الآلة الحاسبة", "calculator"}, {"التقويم", "calendar"}, {"الساعة", "clock"}, {"المنبه", "clock"},
            {"الصور", "photos"}, {"المعرض", "gallery"}, {"الاستوديو", "gallery"}, {"سبوتيفاي", "spotify"},
            {"نتفلكس", "netflix"}, {"شاهد", "shahid"}, {"ابشر", "absher"}, {"أبشر", "absher"},
            {"توكلنا", "tawakkalna"}, {"صحتي", "sehhaty"}, {"الراجحي", "alrajhi"}, {"الأهلي", "alahli"},
            {"اوبر", "uber"}, {"كريم", "careem"}, {"جاهز", "jahez"}, {"هنقرستيشن", "hungerstation"},
            {"نون", "noon"}, {"امازون", "amazon"}, {"أمازون", "amazon"}, {"المتجر", "vending"},
            {"قوقل بلاي", "vending"}, {"الملفات", "files"}, {"الرسائل", "messaging"}, {"الهاتف", "dialer"},
            {"جهات الاتصال", "contacts"}, {"الملاحظات", "notes"}, {"زووم", "zoom"}, {"تيمز", "teams"},
        };
        for (String[] pair : pairs) ALIASES.put(normalize(pair[0]), pair[1]);
    }

    public static final class Match {
        public final String packageName;
        public final String label;

        Match(String packageName, String label) {
            this.packageName = packageName;
            this.label = label;
        }
    }

    static String normalize(String value) {
        if (value == null) return "";
        String text = Normalizer.normalize(value, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT)
            .replaceAll("[\\u064B-\\u0652\\u0640]", "")
            .replaceAll("[أإآ]", "ا").replace('ة', 'ه').replace('ى', 'ي')
            .replaceAll("[^\\p{L}\\p{N} ]", " ")
            .replaceAll("\\s+", " ").trim();
        if (text.startsWith("تطبيق ")) text = text.substring(6).trim();
        return text;
    }

    /** Best launcher match for the spoken name, or null. */
    public static Match find(Context context, String spokenName) {
        String wanted = normalize(spokenName);
        if (wanted.isEmpty()) return null;
        String alias = ALIASES.get(wanted);

        PackageManager manager = context.getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> activities = manager.queryIntentActivities(launcher, 0);

        List<Match> exact = new ArrayList<>();
        List<Match> partial = new ArrayList<>();
        for (ResolveInfo info : activities) {
            if (info.activityInfo == null) continue;
            String packageName = info.activityInfo.packageName;
            CharSequence rawLabel = info.loadLabel(manager);
            String label = rawLabel == null ? packageName : rawLabel.toString();
            String normalizedLabel = normalize(label);
            String normalizedPackage = packageName.toLowerCase(Locale.ROOT);
            Match match = new Match(packageName, label);
            if (normalizedLabel.equals(wanted) || (alias != null && normalizedLabel.equals(alias))) {
                exact.add(match);
            } else if (normalizedLabel.contains(wanted) || (normalizedLabel.length() >= 3 && wanted.contains(normalizedLabel))
                || (alias != null && (normalizedLabel.contains(alias) || normalizedPackage.contains(alias)))) {
                partial.add(match);
            }
        }
        if (!exact.isEmpty()) return exact.get(0);
        if (!partial.isEmpty()) return partial.get(0);
        return null;
    }

    /** Launches the app; returns its label, or null when nothing matched. */
    public static String launch(Context context, String spokenName) {
        Match match = find(context, spokenName);
        if (match == null) return null;
        Intent intent = context.getPackageManager().getLaunchIntentForPackage(match.packageName);
        if (intent == null) return null;
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        context.startActivity(intent);
        return match.label;
    }
}
