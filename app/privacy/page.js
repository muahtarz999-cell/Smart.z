import { LegalPage, List, Section } from '../../components/LegalPage';
import { CONTACT_EMAIL, LEGAL_ENTITY, POLICY_UPDATED_AR, POLICY_UPDATED_EN } from '../../lib/legal-entity';

export const metadata = {
  title: 'سياسة الخصوصية · Privacy Policy — Smart.z',
  description: 'How Smart.z handles your data.',
};

const deletionAr = CONTACT_EMAIL ? `أو راسلنا على ${CONTACT_EMAIL}` : 'أو تواصل معنا عبر بيانات التواصل أدناه';
const deletionEn = CONTACT_EMAIL ? `or email us at ${CONTACT_EMAIL}` : 'or contact us using the details below';

export default function PrivacyPage() {
  return (
    <LegalPage
      titleAr="سياسة الخصوصية"
      titleEn="Privacy Policy"
      updatedAr={POLICY_UPDATED_AR}
      updatedEn={POLICY_UPDATED_EN}
      arabic={(
        <>
          <p className="text-sm leading-7 text-text-secondary">
            تطبيق {LEGAL_ENTITY.product} مساعد ذكي تشغّله {LEGAL_ENTITY.nameAr}. تشرح هذه السياسة ما نحفظه، وأين، ولماذا، وكيف تحذفه.
          </p>
          <Section title="1. ما يبقى على جهازك فقط">
            <p>يُحفظ المحتوى الشخصي داخل التطبيق على جهازك، ولا نحفظه على خوادمنا:</p>
            <List items={[
              'ملفك الشخصي وما يتعلّمه المساعد عنك وذكرياتك.',
              'ملفاتك ومستنداتك ومواد المذاكرة.',
              'تقرير رسائل واتساب بعد استلامه على الهاتف.',
              'إعداداتك، ومنها مشاركة الموقع إن فعّلتها.',
            ]} />
            <p>يُمسح هذا المحتوى عند تسجيل حساب آخر على الجهاز أو مسح بيانات التطبيق.</p>
          </Section>
          <Section title="2. ما نحفظه على خوادمنا">
            <List items={[
              'الحساب: البريد المستخدم للدخول، وحالة الاشتراك وتواريخه، ومعرّف الجهاز المرتبط بالحساب.',
              'ربط واتساب للأعمال: معرّف حساب واتساب للأعمال ومعرّف الرقم والرقم الظاهر واسم النشاط، ورمز الوصول الذي تمنحه Meta لتشغيل الخدمة.',
              'إعدادات الرد الآلي: تفعيله، ونطاقه، والأرقام المسموح لها، ونمط الرد الصوتي.',
              'ربط واتساب عبر جهاز مرتبط (رمز QR): بيانات الجلسة اللازمة لبقاء الربط، وأسماء جهات الاتصال والمجموعات لتسهيل الإرسال بالاسم.',
            ]} />
            <p>تُخزَّن هذه البيانات لدى مزوّد قاعدة البيانات Supabase، وتصل إليها خوادمنا فقط.</p>
          </Section>
          <Section title="3. ما يمر للمعالجة دون أن نحفظه">
            <p>لتوليد الردود والصوت، يمر نص طلبك أو رسالتك أو صوتك أو صورتك عبر مزوّدي المعالجة التاليين، ثم يُتلف بعد الرد:</p>
            <List items={[
              'Cloudflare: استضافة التطبيق وواجهاته.',
              'Render: تشغيل جلسات واتساب المرتبطة برمز QR.',
              'Groq: توليد الردود، وتحويل الصوت إلى نص، وتوليد الصوت.',
              'OpenRouter: توليد الردود وتحليل الصور احتياطيًا، مع منع المزوّدين الذين يحتفظون بالبيانات أو يدرّبون عليها.',
              'Google (Gemini وCloud Text-to-Speech) وMicrosoft Azure Speech: تحليل الصور وتوليد الصوت.',
              'Meta (WhatsApp Cloud API): استقبال رسائل واتساب للأعمال وإرسالها.',
            ]} />
            <p>عند استخدام المساعد، قد يُرفق ملفك الشخصي وذكرياتك بالطلب ليكون الرد مناسبًا لك.</p>
          </Section>
          <Section title="4. رسائل واتساب للأعمال">
            <p>
              عند ربط حساب واتساب للأعمال، نعالج رسائل عملائك نيابة عنك ووفق إعداداتك فقط، لنولّد الردود ونعرض لك التقرير.
              لا نستخدم محتوى الرسائل لتدريب أي نموذج ذكاء اصطناعي، ولا نشاركه مع عملاء آخرين، ولا نبيعه.
              عبر التسجيل من خلال Meta نستلم معرّفات حسابك في واتساب للأعمال ورمز الوصول، ولا نستلم ملفك الشخصي في فيسبوك.
            </p>
          </Section>
          <Section title="5. ما لا نفعله">
            <List items={[
              'لا نبيع بياناتك ولا نؤجرها.',
              'لا نعرض إعلانات ولا نبني ملفات تسويقية عنك.',
              'لا ندرّب نماذج ذكاء اصطناعي على بياناتك أو رسائلك.',
            ]} />
          </Section>
          <Section title="6. مدة الحفظ والحذف">
            <List items={[
              'بيانات الحساب: طوال بقاء الحساب.',
              'ربط واتساب: حتى تفصله من التطبيق، فتُحذف بياناته.',
              'الرسائل الواردة على الخادم: في الذاكرة فقط حتى يستلمها هاتفك.',
            ]} />
            <p>
              لحذف حسابك وكل ما يرتبط به، افصل واتساب من التطبيق {deletionAr}، ونحذف البيانات خلال 30 يومًا.
              تعليمات حذف البيانات المرتبطة بتسجيل الدخول عبر Meta في صفحة <a className="text-gold underline" href="/data-deletion">حذف البيانات</a>.
            </p>
          </Section>
          <Section title="7. الحماية">
            <p>تنتقل البيانات مشفّرة عبر HTTPS، والوصول إلى قاعدة البيانات مقصور على خوادمنا بصلاحيات محددة.</p>
          </Section>
        </>
      )}
      english={(
        <>
          <p className="text-sm leading-7 text-text-secondary">
            {LEGAL_ENTITY.product} is an AI assistant operated by {LEGAL_ENTITY.nameAr}. This policy explains what we store, where, why, and how to delete it.
          </p>
          <Section title="1. What stays on your device only">
            <p>Your personal content in the app is stored on your device, not on our servers:</p>
            <List items={[
              'Your profile, what the assistant learns about you, and your memories.',
              'Your files, documents and study materials.',
              'Your WhatsApp message report once it reaches your phone.',
              'Your settings, including location sharing if you turn it on.',
            ]} />
            <p>This content is erased when another account signs in on the device or the app data is cleared.</p>
          </Section>
          <Section title="2. What we store on our servers">
            <List items={[
              'Account: your sign-in email, subscription status and dates, and the device ID bound to the account.',
              'WhatsApp Business connection: WhatsApp Business Account ID, phone number ID, display number, business name, and the access token Meta grants to run the service.',
              'Auto-reply settings: whether it is on, its scope, allowed numbers, and voice reply mode.',
              'WhatsApp linked-device connection (QR code): session data needed to keep the link, and contact and group names used to send by name.',
            ]} />
            <p>This data is stored with our database provider, Supabase, and only our servers can access it.</p>
          </Section>
          <Section title="3. What passes through for processing and is not stored">
            <p>To generate replies and audio, your request, message, voice or image passes through these processors and is discarded after the reply:</p>
            <List items={[
              'Cloudflare: hosting for the app and its APIs.',
              'Render: running WhatsApp sessions linked by QR code.',
              'Groq: generating replies, speech-to-text and text-to-speech.',
              'OpenRouter: backup replies and image analysis, restricted to providers that do not retain or train on data.',
              'Google (Gemini and Cloud Text-to-Speech) and Microsoft Azure Speech: image analysis and speech.',
              'Meta (WhatsApp Cloud API): receiving and sending WhatsApp Business messages.',
            ]} />
            <p>When you use the assistant, your profile and memories may be sent with the request so the reply fits you.</p>
          </Section>
          <Section title="4. WhatsApp Business messages">
            <p>
              When you connect a WhatsApp Business account, we process your customers' messages on your behalf and only under your settings, to generate replies and show you a report.
              We do not use message content to train any AI model, share it with other customers, or sell it.
              Through Meta's signup we receive your WhatsApp Business account identifiers and an access token, not your Facebook profile.
            </p>
          </Section>
          <Section title="5. What we do not do">
            <List items={[
              'We do not sell or rent your data.',
              'We do not show ads or build marketing profiles about you.',
              'We do not train AI models on your data or messages.',
            ]} />
          </Section>
          <Section title="6. Retention and deletion">
            <List items={[
              'Account data: for as long as the account exists.',
              'WhatsApp connection: until you disconnect it in the app, which deletes its data.',
              'Incoming messages on the server: in memory only until your phone collects them.',
            ]} />
            <p>
              To delete your account and everything linked to it, disconnect WhatsApp in the app {deletionEn}; we delete the data within 30 days.
              Instructions for data linked to signing in with Meta are on the <a className="text-gold underline" href="/data-deletion">data deletion</a> page.
            </p>
          </Section>
          <Section title="7. Security">
            <p>Data travels encrypted over HTTPS, and database access is limited to our servers with specific permissions.</p>
          </Section>
        </>
      )}
    />
  );
}
