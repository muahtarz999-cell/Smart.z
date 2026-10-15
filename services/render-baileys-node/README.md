# خادم WhatsApp الشخصي لـ Smart.z (Render)

خادم واحد = جلسة WhatsApp واحدة = عميل واحد. التطبيق يحدد من يملك الخادم؛ هذا الخادم يحفظ الجلسة، ويُصدر رمز QR أو رمز الاقتران عند الطلب، ويمرر الرسائل النصية الواردة إلى التطبيق، ويمسح الجلسة كاملة عند `/api/reset`.

## متغيرات البيئة لكل خادم

| المتغير | مثال | ملاحظة |
| :--- | :--- | :--- |
| `CLUSTER_NODE_ID` | `1` … `5` | رقم الخادم، مطابق لرقم `RENDER_SERVER_X` في التطبيق |
| `CLUSTER_NODE_KEY` | 32 حرفاً عشوائياً على الأقل 24 | نفس قيمة `RENDER_SERVER_X_KEY` في التطبيق. الخادم يرفض التشغيل بدونه |
| `SMART_Z_APP_URL` | `https://smart-z.pages.dev` | رابط التطبيق |
| `SUPABASE_URL` | `https://xxxx.supabase.co` | لحفظ الجلسة في قاعدة البيانات بدل القرص المؤقت |
| `SUPABASE_SERVICE_ROLE_KEY` | — | سري. بدونه تُحفظ الجلسة على القرص وتضيع مع كل إعادة تشغيل |
| `LOG_LEVEL` | `warn` | اختياري |

## النشر

1. Web Service، البيئة Node 20 أو أحدث.
2. Build: `npm install` · Start: `npm start`.
3. Health Check Path: `/healthz` (المسار الوحيد بلا مفتاح).
4. لا حاجة لقرص دائم إذا ضُبط `SUPABASE_URL` و`SUPABASE_SERVICE_ROLE_KEY`.

## المسارات (كلها تتطلب `Authorization: Bearer <CLUSTER_NODE_KEY>`)

| المسار | الوظيفة |
| :--- | :--- |
| `GET /api/status` | الحالة: `IDLE` · `STARTING` · `WAITING_QR` · `CONNECTING` · `CONNECTED` · `ERROR` |
| `GET /api/connect?method=qr` | يعيد آخر رمز QR، أو `202 pending` أثناء التجهيز |
| `GET /api/connect?method=pairing_code&phoneNumber=9665…` | يعيد رمز اقتران من 8 خانات |
| `POST /api/reset` | تسجيل خروج ومسح الجلسة بالكامل |
| `POST /api/send` | إرسال رسالة نصية `{ remoteJid, text }` |

## إدخال رمز الاقتران على الهاتف

WhatsApp ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز ← «الربط برقم الهاتف بدلاً من ذلك» ← اكتب الرمز. لا يوجد رابط يفتح هذه الشاشة مباشرة.
