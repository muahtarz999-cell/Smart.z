# خادم عنقود Baileys الموزع لـ Smart.z (Render Node)

هذا المجلد يحتوي على الكود الموحد الجاهز للنشر على خوادم **Render** الخمسة.

## 🛠️ متغيرات البيئة المطلوبة على كل حساب Render:

| المتغير | القيمة النموذجية | الوصف |
| :--- | :--- | :--- |
| `PORT` | `3000` | منفذ السيرفر الداخلي |
| `SMART_Z_APP_URL` | `https://smart-z.pages.dev` | رابط تطبيق Smart.z الرئيسي على Cloudflare |
| `CLUSTER_NODE_ID` | `1` (أو `2`, `3`, `4`, `5`) | رقم النود الخاص بهذا الحساب |
| `CLUSTER_NODE_KEY` | `rnd_dummy_key_1` | مفتاح الأمان المتطابق مع `RENDER_SERVER_X_KEY` في Smart.z |

## 🚀 طريقة النشر على Render:
1. أنشئ **Web Service** جديدة في حساب Render.
2. حدد **Environment:** `Node`.
3. **Build Command:** `npm install`
4. **Start Command:** `npm start`
5. اضف **Persistent Disk** (اختياري/موصى به) مثبت على المسار `/opt/render/project/src/auth_info_baileys` لحفظ الجلسة عند إعادة التشغيل.

