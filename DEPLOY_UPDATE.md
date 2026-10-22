# خطوات تطبيق التحديث (2026-10-22)

دليل تطبيق التحديث على GitHub وCloudflare وSupabase والهاتف والكمبيوتر.
**نفّذ الخطوات بالترتيب.** متغيرات البيئة مشروحة بالتفصيل في `ENV_SETUP.md`.

## ما الذي يحتويه التحديث

- **ربط الكمبيوتر:** الكمبيوتر صار يعرض رمز QR بدل فتح الكاميرا، وأُصلح نموذج «طلب المهمة» في صفحة الهاتف.
- **أوامر الكمبيوتر بالكلام:** المساعد يرسل مهام للكمبيوتر بعد موافقتك.
- **إجراءات الهاتف:** فتح التطبيقات، الاتصال، SMS، المنبه، المؤقت، التقويم، الخرائط، البحث، الإعدادات.
- **التحكم في أي تطبيق أندرويد** عبر إمكانية الوصول.
- **تطبيق الكمبيوتر:** فتح ملفات وروابط، وتشغيل برامج وأوامر من قائمة محلية. وأُصلح خطآن كانا يمنعان بناءه.
- **معرفة المساعد بنفسه:** يعرف تكوينه وكل قدراته وما المربوط الآن.

---

## الخطوة 1 — Supabase: ترحيل قاعدة البيانات (يدوي، أولًا)

**نعم، الترحيل يدوي.** لا يوجد في المشروع أي سير عمل GitHub يطبّق ترحيلات Supabase، والنشر الآلي يخص Cloudflare وAPK فقط. **طبّقه قبل نشر الخادم**: الخادم الجديد يحتاجه لأنواع مهام الكمبيوتر الجديدة، والخادم القديم لا يتأثر به.

**الملف:** `supabase/migrations/202610220001_computer_actions.sql`

**الطريقة الأسهل (لوحة Supabase):**
1. افتح مشروعك في supabase.com ← **SQL Editor** ← **New query**.
2. الصق محتوى الملف كاملًا، من `begin;` إلى `commit;`.
3. اضغط **Run**. يجب أن تظهر `Success. No rows returned`.

**أو من سطر الأوامر** (إن كان المشروع مربوطًا بـSupabase CLI):

```bash
npx supabase link --project-ref <معرّف مشروعك>
npx supabase db push
```

> تنبيه: `db push` يطبّق **كل** الترحيلات التي لم تُسجَّل عندك. إن كنت طبّقت الترحيلات السابقة يدويًا من SQL Editor، فقد يحاول إعادتها ويفشل. في هذه الحالة استخدم الطريقة اليدوية أعلاه.

**تحقق أنه طُبّق** (في SQL Editor):

```sql
select pg_get_constraintdef(oid)
from pg_constraint
where conname = 'computer_tasks_task_type_check';
```

يجب أن تظهر الأنواع الثمانية، ومنها `open_app` و`run_command`.

**إن ظهر خطأ أن الجدول `computer_tasks` غير موجود:** معناه أن ترحيلات ربط الكمبيوتر السابقة لم تُطبَّق. طبّقها أولًا بالترتيب: `202610180002` ← `202610180003` ← `202610180004` ← `202610180005` ← `202610180006` ← `202610180007`، ثم هذا الترحيل.

---

## الخطوة 2 — GitHub: رفع المشروع

### ⚠️ ارفع عبر git، وليس بسحب الملفات إلى موقع GitHub

الرفع بالسحب والإفلات في المتصفح **يتجاهل `.gitignore`**، فيرفع ملفات الأسرار (`.env.local` و`.env.development.local` و`.env.local.backup`) و`node_modules` الضخم. استخدم git من سطر الأوامر أو GitHub Desktop، فهما يحترمان `.gitignore`.

### الفرع

التعديلات محفوظة في git داخل المجلد على الفرع **`test/android-document-export-fix`**، في commits جاهزة. **النشر على Cloudflare لا يعمل إلا من `main`.** من داخل مجلد المشروع:

```bash
git status                       # تأكد أنه لا توجد ملفات .env ضمن التغييرات
git push origin test/android-document-export-fix
```

ثم على GitHub افتح **Pull request** من هذا الفرع إلى `main` واعتمده (Merge).

أو مباشرة دون Pull request:

```bash
git checkout main
git pull origin main
git merge test/android-document-export-fix
git push origin main
```

الملف `windows-agent/local-actions.json` (قائمتك المحلية) والمجلد `.codex-remote-attachments/` لا يُرفعان، وهذا مقصود.

### أسرار GitHub المطلوبة

في **Settings ← Secrets and variables ← Actions**. **لا يوجد سر جديد**، فقط تأكد من وجود هذه:

| السر | يستخدمه |
|---|---|
| `CLOUDFLARE_API_TOKEN`، `CLOUDFLARE_ACCOUNT_ID` | النشر على Cloudflare |
| `NEXT_PUBLIC_SUPABASE_URL`، `NEXT_PUBLIC_SUPABASE_ANON_KEY` | بناء الواجهة. بدونها تظهر «إعداد Supabase Auth غير مكتمل» |
| `GROQ_API_KEY` (و`_2` … `_5` اختياريًا)، `OPENROUTER_API_KEY` | المساعد. تُزامَن تلقائيًا إلى Cloudflare |
| `AZURE_SPEECH_KEY`، `AZURE_SPEECH_REGION` | الصوت السحابي |
| `ANDROID_KEYSTORE_BASE64`، `ANDROID_KEYSTORE_PASSWORD`، `ANDROID_KEY_ALIAS`، `ANDROID_KEY_PASSWORD` | توقيع APK حتى يتحدث التطبيق دون حذفه |

---

## الخطوة 3 — Cloudflare: النشر (تلقائي بعد الدمج في main)

عند الدفع إلى `main` يعمل سير العمل **Deploy Smart.z Worker** (`deploy-workers.yml`). يشغّل الاختبارات، ويزامن مفاتيح Groq وOpenRouter وAzure إلى الـWorker، ثم ينشر.

**تحقق:** GitHub ← **Actions** ← آخر تشغيل لـ«Deploy Smart.z Worker» يجب أن يكون ✅.

**مفتاح واحد لا يزامنه سير العمل ويجب أن يكون موجودًا في Cloudflare:** `SUPABASE_SERVICE_ROLE_KEY`. بدونه لا تعمل مهام الكمبيوتر. للتحقق:

```bash
npx wrangler secret list --name smart-z
```

إن لم يظهر:

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --name smart-z
```

أو من لوحة Cloudflare: **Workers & Pages ← smart-z ← Settings ← Variables and Secrets ← Add ← Secret**.

> ملاحظة: يوجد سير عمل ثانٍ للنشر هو `cloudflare-workers.yml` («Deploy OpenNext to Cloudflare Workers»)، ويعمل هو أيضًا عند كل دفع إلى `main`، فيُنشر الموقع مرتين. لا يضر، لكن يُفضَّل تعطيل أحدهما من **Actions ← اسم السير ← ⋯ ← Disable workflow**. أبقِ `deploy-workers.yml` لأنه يزامن المفاتيح.

---

## الخطوة 4 — تطبيق أندرويد (APK)

يُبنى تلقائيًا عند الدفع بسير العمل **Android APK**.
1. GitHub ← **Actions** ← آخر تشغيل لـ«Android APK» ← **Artifacts** ← `smartz-android-apk`.
2. ثبّت ملف APK الموقّع (release) فوق النسخة الحالية. إن رفض الهاتف التحديث فمفتاح التوقيع مختلف؛ راجع «بناء APK.md» قبل حذف أي شيء، **لأن حذف التطبيق يمسح بياناته**.
3. بعد التثبيت، على الهاتف:
   - **التحكم في التطبيقات:** الإعدادات ← إمكانية الوصول ← التطبيقات المثبتة ← **Smart.z — التحكم في التطبيقات** ← تشغيل. التطبيق يفتح هذه الصفحة تلقائيًا عند أول طلب.
   - اسمح بـ**الإشعارات** حتى يظهر زر «إيقاف».
   - **جهات الاتصال** تُطلب تلقائيًا عند أول «اتصل بـ…» بالاسم.

> هذا التحديث يحتوي كود أندرويد جديدًا لم يُبنَ بعد. إن فشل البناء في Actions فأرسل سجل الخطأ لإصلاحه.

---

## الخطوة 5 — تطبيق الكمبيوتر (Windows)

**لا يُبنى على GitHub**، بل على الكمبيوتر نفسه. اختر إحدى النسختين.

### النسخة الرسومية C# (`computer-agent`) — المفضّلة
1. ثبّت **.NET SDK 10** من dotnet.microsoft.com، ثم أعد فتح PowerShell.
2. في PowerShell داخل مجلد المشروع:
   ```powershell
   cd computer-agent
   powershell -ExecutionPolicy Bypass -File .\Publish.ps1
   powershell -ExecutionPolicy Bypass -File .\Install.ps1
   ```
3. افتح **Smart.z Computer Agent** من قائمة ابدأ.
   - إن كان مربوطًا سابقًا تبقى إعداداته.
   - أضف ما تريد بأزرار **إضافة مجلد** و**إضافة برنامج** و**إضافة أمر**.
   - اضغط **تشغيل استقبال المهام**.

> هذه النسخة لم تُبنَ بعد التعديل. إن ظهر خطأ في `Publish.ps1` فأرسل نصه لإصلاحه.

### نسخة Node (`windows-agent`)
1. انسخ `local-actions.example.json` إلى `local-actions.json` وعدّل البرامج والأوامر.
2. شغّل `start-agent.bat` كالمعتاد.

---

## الخطوة 6 — اختبار بعد النشر

| الاختبار | النتيجة المتوقعة |
|---|---|
| على الكمبيوتر: القائمة ← ربط الكمبيوتر | يظهر خيار «اعرض رمز QR» أولًا، ويولّد الرمز |
| على الهاتف: «امسح رمز الكمبيوتر» ← امسح ← وافق | يكتمل الربط على الكمبيوتر |
| قل: «وش تقدر تسوي؟» | يشرح قدراته ويذكر ما هو مربوط الآن |
| قل: «افتح يوتيوب» | يفتح التطبيق |
| قل: «اضبط منبه الساعة ٦ ونص» | يُضبط المنبه |
| قل: «ابحث في الكمبيوتر عن ملف فاتورة» | يظهر طلب موافقة، ثم النتيجة. يلزم تحديد المجلد مرة واحدة في صفحة مهام الكمبيوتر |
| قل: «في يوتيوب ابحث عن وصفة كبسة» | إشعار «Smart.z يتحكم في الهاتف» وزر إيقاف، ثم ينفذ |
| قل: «أوقف» أثناء التحكم | يتوقف |

## التراجع عند مشكلة

- **الخادم:** Cloudflare ← smart-z ← **Deployments** ← اختر النسخة السابقة ← **Rollback**.
- **الكود:** `git revert <رقم الـcommit>` ثم ادفع إلى `main`.
- **قاعدة البيانات:** الترحيل يضيف أنواعًا جديدة فقط، والنسخة القديمة من الخادم تعمل معه، فلا حاجة للتراجع عنه.
