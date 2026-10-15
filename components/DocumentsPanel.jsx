'use client';

/**
 * "مستنداتي": write documents and contracts with the assistant, edit them,
 * keep versions, export to Word, print to PDF, and send through WhatsApp.
 * Documents live on this device only.
 */

import { useEffect, useState } from 'react';
import { DOCUMENT_TEMPLATES, getTemplate, LEGAL_DISCLAIMER } from '../lib/document-templates';
import {
  deleteDocument, documentToDocx, getDocument, isContract, listDocuments, printDocument, saveDocument, shareOrDownload,
} from '../lib/documents';
import { blobToBase64 } from '../lib/file-processing';

const button = 'min-h-9 rounded-md border border-base-border px-3 text-xs text-text-primary hover:bg-base-panel disabled:opacity-50';
const primary = 'min-h-10 rounded-lg bg-gold px-3 text-sm font-semibold text-base-bg disabled:opacity-50';

export default function DocumentsPanel({ getAccessToken, initialTemplateId, onConsumedInitial }) {
  const [view, setView] = useState({ name: 'list' }); // list | wizard | free | editor
  const [documents, setDocuments] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function reload() {
    setDocuments(await listDocuments().catch(() => []));
  }

  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    if (initialTemplateId && getTemplate(initialTemplateId)) {
      setView({ name: 'wizard', templateId: initialTemplateId, step: 0, fields: {} });
      onConsumedInitial?.();
    }
  }, [initialTemplateId, onConsumedInitial]);

  async function draft(payload) {
    setBusy(true);
    setMessage('');
    try {
      const token = await getAccessToken();
      const response = await fetch('/api/documents/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.body) throw new Error(data.message || 'تعذر كتابة المستند.');
      return data;
    } catch (error) {
      setMessage(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------ list
  if (view.name === 'list') {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-base font-semibold text-text-primary">مستنداتي</h2>
          <p className="mt-1 text-xs leading-5 text-text-secondary">يكتب المساعد المستندات والعقود، وتُحفظ على هذا الجهاز فقط. أو قل: «اكتب لي عقد إيجار».</p>
        </div>
        <button type="button" onClick={() => setView({ name: 'free', instruction: '' })} className={`${primary} w-full`}>مستند جديد بطلب حر</button>
        <div>
          <h3 className="mb-2 text-xs text-text-secondary">أو ابدأ من قالب</h3>
          <div className="grid grid-cols-2 gap-2">
            {DOCUMENT_TEMPLATES.map((template) => (
              <button key={template.id} type="button" onClick={() => setView({ name: 'wizard', templateId: template.id, step: 0, fields: {} })}
                className="min-h-11 rounded-lg border border-base-border bg-base-card px-2 text-sm text-text-primary hover:border-gold/50">{template.title}</button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <h3 className="text-xs text-text-secondary">المستندات المحفوظة</h3>
          {documents === null ? <p className="text-sm text-text-secondary">جارٍ التحميل…</p>
            : documents.length === 0 ? <p className="rounded-lg border border-base-border bg-base-card px-4 py-4 text-sm text-text-secondary">لا توجد مستندات بعد.</p>
              : (
                <ul className="space-y-2">
                  {documents.map((doc) => (
                    <li key={doc.id}>
                      <button type="button" onClick={() => setView({ name: 'editor', id: doc.id })}
                        className="w-full rounded-lg border border-base-border bg-base-card p-3 text-right hover:border-gold/50">
                        <span className="block truncate text-sm text-text-primary">{doc.title}</span>
                        <span className="text-[11px] text-text-secondary">{new Date(doc.updatedAt).toLocaleString('ar')}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
        </div>
      </div>
    );
  }

  const back = <button type="button" onClick={() => { setView({ name: 'list' }); setMessage(''); void reload(); }} className="text-xs text-text-secondary">→ المستندات</button>;

  // ------------------------------------------------------------ free request
  if (view.name === 'free') {
    return (
      <div className="space-y-3">
        {back}
        <label className="block space-y-1.5">
          <span className="text-sm text-text-primary">ماذا تريد أن أكتب؟</span>
          <textarea rows={6} value={view.instruction} onChange={(e) => setView({ ...view, instruction: e.target.value })}
            placeholder="مثال: خطاب لمديري أطلب فيه إجازة أسبوع من 1 نوفمبر لظرف عائلي"
            className="w-full rounded-lg border border-base-border bg-base-panel px-3 py-2 text-sm leading-7 text-text-primary" dir="auto" />
        </label>
        <button type="button" disabled={busy || !view.instruction.trim()} className={`${primary} w-full`} onClick={async () => {
          const result = await draft({ instruction: view.instruction });
          if (result) {
            const doc = await saveDocument({ title: result.title, body: result.body });
            setView({ name: 'editor', id: doc.id });
          }
        }}>{busy ? 'يكتب…' : 'اكتب المسودة'}</button>
        {message && <p role="alert" className="text-xs text-amber-300">{message}</p>}
      </div>
    );
  }

  // ------------------------------------------------------------ guided template
  if (view.name === 'wizard') {
    const template = getTemplate(view.templateId);
    const field = template.fields[view.step];
    const last = view.step === template.fields.length - 1;
    const value = view.fields[field.id] || '';
    const canGo = !field.required || value.trim();
    return (
      <div className="space-y-4">
        {back}
        <div>
          <h2 className="text-base font-semibold text-text-primary">{template.title}</h2>
          <p className="text-[11px] text-text-secondary">سؤال {view.step + 1} من {template.fields.length}</p>
          <div className="mt-2 h-1 rounded bg-base-border"><div className="h-1 rounded bg-gold" style={{ width: `${((view.step + 1) / template.fields.length) * 100}%` }} /></div>
        </div>
        <label className="block space-y-2">
          <span className="text-sm leading-7 text-text-primary">{field.question}{field.required ? '' : ' (اختياري)'}</span>
          <textarea rows={3} autoFocus value={value} onChange={(e) => setView({ ...view, fields: { ...view.fields, [field.id]: e.target.value } })}
            className="w-full rounded-lg border border-base-border bg-base-panel px-3 py-2 text-sm leading-7 text-text-primary" dir="auto" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={button} disabled={view.step === 0} onClick={() => setView({ ...view, step: view.step - 1 })}>السابق</button>
          {last ? (
            <button type="button" className={primary} disabled={busy || !canGo} onClick={async () => {
              const result = await draft({ templateId: template.id, fields: view.fields });
              if (result) {
                const doc = await saveDocument({ title: result.title, body: result.body, templateId: template.id, fields: view.fields });
                setView({ name: 'editor', id: doc.id });
              }
            }}>{busy ? 'يكتب…' : 'اكتب المسودة'}</button>
          ) : (
            <button type="button" className={primary} disabled={!canGo} onClick={() => setView({ ...view, step: view.step + 1 })}>التالي</button>
          )}
        </div>
        {template.contract && <p className="text-[11px] leading-5 text-text-secondary">{LEGAL_DISCLAIMER}</p>}
        {message && <p role="alert" className="text-xs text-amber-300">{message}</p>}
      </div>
    );
  }

  return <DocumentEditor id={view.id} back={back} draft={draft} busy={busy} message={message} setMessage={setMessage} getAccessToken={getAccessToken} />;
}

function DocumentEditor({ id, back, draft, busy, message, setMessage, getAccessToken }) {
  const [doc, setDoc] = useState(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [instruction, setInstruction] = useState('');
  const [recipientQuery, setRecipientQuery] = useState('');
  const [matches, setMatches] = useState(null);
  const [sending, setSending] = useState(false);

  async function load() {
    const loaded = await getDocument(id);
    setDoc(loaded);
    setTitle(loaded?.title || '');
    setBody(loaded?.body || '');
  }
  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc) return <p className="text-sm text-text-secondary">جارٍ التحميل…</p>;
  const dirty = title !== doc.title || body !== doc.body;

  async function save() {
    setDoc(await saveDocument({ id, title, body }));
    setMessage('تم الحفظ.');
  }

  async function searchRecipient() {
    setMatches(null);
    const token = await getAccessToken();
    const response = await fetch(`/api/whatsapp/cluster/contacts?q=${encodeURIComponent(recipientQuery)}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setMessage(data.message || 'تعذر البحث.'); return; }
    setMatches(data.matches || []);
  }

  async function sendTo(match) {
    setSending(true);
    try {
      const file = documentToDocx({ ...doc, title, body });
      const token = await getAccessToken();
      const response = await fetch('/api/whatsapp/cluster/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          recipients: [{ jid: match.jid }],
          text: '',
          document: { data: await blobToBase64(file), fileName: file.name, mimetype: file.type },
        }),
      });
      const data = await response.json().catch(() => ({}));
      setMessage(response.ok ? `أُرسل إلى ${match.name} ✓` : data.error || 'تعذر الإرسال.');
      setMatches(null);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3">
      {back}
      <input value={title} onChange={(e) => setTitle(e.target.value)} className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-sm font-semibold text-text-primary" />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} dir="auto"
        className="w-full rounded-lg border border-base-border bg-base-panel px-3 py-2 text-sm leading-7 text-text-primary" />
      {isContract(doc) && <p className="text-[11px] leading-5 text-text-secondary">{LEGAL_DISCLAIMER}</p>}

      <div className="grid grid-cols-3 gap-2">
        <button type="button" className={button} disabled={!dirty} onClick={save}>حفظ</button>
        <button type="button" className={button} onClick={() => shareOrDownload(documentToDocx({ ...doc, title, body }))}>Word</button>
        <button type="button" className={button} onClick={() => printDocument({ ...doc, title, body })}>طباعة / PDF</button>
      </div>

      <div className="space-y-2 rounded-lg border border-base-border bg-base-card p-3">
        <span className="text-xs text-text-secondary">عدّل بطلب: «أضف بنداً عن الصيانة»، «اجعل الأسلوب أكثر رسمية»</span>
        <div className="flex gap-2">
          <input value={instruction} onChange={(e) => setInstruction(e.target.value)} dir="auto"
            className="h-10 min-w-0 flex-1 rounded-md border border-base-border bg-base-panel px-3 text-sm text-text-primary" />
          <button type="button" className={button} disabled={busy || !instruction.trim()} onClick={async () => {
            const result = await draft({ templateId: doc.templateId, currentBody: body, instruction });
            if (result) {
              const saved = await saveDocument({ id, title: title || result.title, body: result.body });
              setDoc(saved); setBody(saved.body); setInstruction('');
            }
          }}>{busy ? '…' : 'نفّذ'}</button>
        </div>
      </div>

      <div className="space-y-2 rounded-lg border border-base-border bg-base-card p-3">
        <span className="text-xs text-text-secondary">إرسال كملف Word عبر واتساب الشخصي</span>
        <div className="flex gap-2">
          <input value={recipientQuery} onChange={(e) => setRecipientQuery(e.target.value)} placeholder="اسم جهة الاتصال أو رقمها"
            className="h-10 min-w-0 flex-1 rounded-md border border-base-border bg-base-panel px-3 text-sm text-text-primary" />
          <button type="button" className={button} disabled={!recipientQuery.trim()} onClick={searchRecipient}>بحث</button>
        </div>
        {matches?.length === 0 && <p className="text-xs text-text-secondary">لا توجد نتيجة.</p>}
        {matches?.map((match) => (
          <button key={match.jid} type="button" disabled={sending} onClick={() => sendTo(match)} className={`${button} w-full`}>
            إرسال إلى {match.isGroup ? 'مجموعة ' : ''}{match.name}
          </button>
        ))}
      </div>

      {doc.versions?.length > 0 && (
        <details className="rounded-lg border border-base-border bg-base-card p-3 text-xs">
          <summary className="cursor-pointer text-text-secondary">النسخ السابقة ({doc.versions.length})</summary>
          <ul className="mt-2 space-y-1">
            {doc.versions.map((version) => (
              <li key={version.at} className="flex items-center justify-between gap-2">
                <span className="text-text-secondary">{new Date(version.at).toLocaleString('ar')}</span>
                <button type="button" className="text-gold" onClick={async () => {
                  const saved = await saveDocument({ id, title: version.title, body: version.body });
                  setDoc(saved); setTitle(saved.title); setBody(saved.body);
                }}>استرجاع</button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <button type="button" onClick={async () => {
        if (window.confirm('حذف هذا المستند من الجهاز؟')) { await deleteDocument(id); back.props.onClick(); }
      }} className="text-xs text-text-secondary hover:text-red-300">حذف المستند</button>
      {message && <p role="status" className="text-xs text-text-secondary">{message}</p>}
    </div>
  );
}
