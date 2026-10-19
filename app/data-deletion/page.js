import { LegalPage, List, Section } from '../../components/LegalPage';
import { CONTACT_EMAIL, POLICY_UPDATED_AR, POLICY_UPDATED_EN } from '../../lib/legal-entity';


export const metadata = {
  title: 'حذف البيانات · Data Deletion — Smart.z',
  description: 'How to delete your Smart.z data, and the status of a deletion request.',
};

export default async function DataDeletionPage({ searchParams }) {
  const params = await searchParams;
  const code = typeof params?.code === 'string' && /^[a-f0-9]{16}$/.test(params.code) ? params.code : null;
  const emailAr = CONTACT_EMAIL ? `راسلنا على ${CONTACT_EMAIL} من بريد حسابك` : 'تواصل معنا عبر بيانات التواصل أدناه';
  const emailEn = CONTACT_EMAIL ? `email ${CONTACT_EMAIL} from your account email` : 'contact us using the details below';

  return (
    <LegalPage
      titleAr="حذف البيانات"
      titleEn="Data Deletion"
      updatedAr={POLICY_UPDATED_AR}
      updatedEn={POLICY_UPDATED_EN}
      arabic={(
        <>
          {code && (
            <Section title={`حالة الطلب ${code}`}>
              <p>
                استلمنا طلب الحذف المرسل من Meta. لا يحتفظ Smart.z بملفك الشخصي في فيسبوك ولا بمعرّف حسابك فيه، فلا توجد بيانات مرتبطة بهذا الطلب لدينا.
                بيانات ربط واتساب للأعمال مرتبطة بحسابك في Smart.z، وتُحذف بالطرق أدناه.
              </p>
            </Section>
          )}
          <Section title="كيف تحذف بياناتك">
            <List items={[
              'فصل واتساب من التطبيق يحذف بيانات الربط ورمز الوصول فورًا.',
              `لحذف حسابك وكل بياناته على خوادمنا، ${emailAr}، ونحذفها خلال 30 يومًا.`,
              'المحتوى المحفوظ على جهازك يُحذف بمسح بيانات التطبيق أو حذفه من الجهاز.',
            ]} />
            <p>تفاصيل ما نحفظه في <a className="text-gold underline" href="/privacy">سياسة الخصوصية</a>.</p>
          </Section>
        </>
      )}
      english={(
        <>
          {code && (
            <Section title={`Request status ${code}`}>
              <p>
                We received the deletion request sent by Meta. Smart.z does not keep your Facebook profile or Facebook user ID, so we hold no data tied to this request.
                WhatsApp Business connection data is tied to your Smart.z account and is deleted as described below.
              </p>
            </Section>
          )}
          <Section title="How to delete your data">
            <List items={[
              'Disconnecting WhatsApp in the app deletes the connection data and access token immediately.',
              `To delete your account and all its data on our servers, ${emailEn}; we delete it within 30 days.`,
              'Content stored on your device is deleted by clearing the app data or removing the app.',
            ]} />
            <p>Details of what we store are in the <a className="text-gold underline" href="/privacy">privacy policy</a>.</p>
          </Section>
        </>
      )}
    />
  );
}
