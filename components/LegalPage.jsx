import { CONTACT_EMAIL, LEGAL_ENTITY } from '../lib/legal-entity';

/** Shared frame for the public legal pages: Arabic first, English below, same content. */
export function LegalPage({ titleAr, titleEn, updatedAr, updatedEn, arabic, english }) {
  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-8 text-text-primary">
      <nav className="mb-6 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
        <a href="/" className="hover:text-text-primary">Smart.z</a>
        <a href="/privacy" className="hover:text-text-primary">الخصوصية · Privacy</a>
        <a href="/terms" className="hover:text-text-primary">الشروط · Terms</a>
        <a href="/data-deletion" className="hover:text-text-primary">حذف البيانات · Data deletion</a>
        <a href="#en" className="hover:text-text-primary">English</a>
      </nav>

      <article dir="rtl" lang="ar" className="legal space-y-4">
        <h1 className="text-2xl font-semibold">{titleAr}</h1>
        {updatedAr && <p className="text-xs text-text-secondary">آخر تحديث: {updatedAr}</p>}
        {arabic}
        <ContactAr />
      </article>

      <hr className="my-10 border-base-border" />

      <article id="en" dir="ltr" lang="en" className="legal space-y-4 text-left">
        <h1 className="text-2xl font-semibold">{titleEn}</h1>
        {updatedEn && <p className="text-xs text-text-secondary">Last updated: {updatedEn}</p>}
        {english}
        <ContactEn />
      </article>
    </main>
  );
}

export function Section({ title, children }) {
  return (
    <section className="space-y-2">
      <h2 className="pt-2 text-lg font-semibold">{title}</h2>
      <div className="space-y-2 text-sm leading-7 text-text-secondary">{children}</div>
    </section>
  );
}

export function List({ items }) {
  return (
    <ul className="list-disc space-y-1 ps-5">
      {items.map((item, index) => <li key={index}>{item}</li>)}
    </ul>
  );
}

function ContactAr() {
  return (
    <Section title="التواصل">
      <p>
        {LEGAL_ENTITY.nameAr}، {LEGAL_ENTITY.typeAr}، الرقم الوطني الموحد {LEGAL_ENTITY.unifiedNumber}، {LEGAL_ENTITY.countryAr}.
      </p>
      {CONTACT_EMAIL && <p>البريد: <a className="text-gold underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>}
    </Section>
  );
}

function ContactEn() {
  return (
    <Section title="Contact">
      <p>
        {LEGAL_ENTITY.nameAr}, a {LEGAL_ENTITY.typeEn} registered in the {LEGAL_ENTITY.countryEn}, Unified No. {LEGAL_ENTITY.unifiedNumber}.
      </p>
      {CONTACT_EMAIL && <p>Email: <a className="text-gold underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>}
    </Section>
  );
}
