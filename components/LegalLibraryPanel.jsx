'use client';

import { useEffect, useState } from 'react';
import { extractPlainText } from '../lib/file-processing';
import { missingArticleNumbers, OFFICIAL_SOURCE, parseLawArticles, SUGGESTED_LAWS, searchLegal, hitsToLegalContext } from '../lib/legal-library';
import { deleteLaw, importedDate, listLaws, saveLaw } from '../lib/legal-store';

const button = 'min-h-9 rounded-md border border-base-border px-3 text-xs text-text-primary hover:bg-base-panel disabled:opacity-50';
const primary = 'min-h-10 rounded-lg bg-gold px-3 text-sm font-semibold text-base-bg disabled:opacity-50';
const field = 'w-full rounded-lg border border-base-border bg-base-panel px-3 py-2 text-sm text-text-primary';

export default function LegalLibraryPanel({ getAccessToken }) {
  const [laws, setLaws] = useState(null); const [importing, setImporting] = useState(false); const [message, setMessage] = useState('');
  const [query, setQuery] = useState(''); const [hits, setHits] = useState(null); const [answer, setAnswer] = useState('');
  const [draft, setDraft] = useState({ name: '', text: '', articles: null });
  const reload = async () => setLaws(await listLaws().catch(() => []));
  useEffect(() => { void reload(); }, []);
  async function readFile(file) { try { const text = await extractPlainText(file); setDraft((d) => ({ ...d, name: d.name || file.name.replace(/\.[^.]+$/, ''), text, articles: parseLawArticles(text) })); setMessage(''); } catch (error) { setMessage(error.message || 'تعذر قراءة الملف.'); } }
  async function save() { if (!draft.name.trim() || !draft.articles?.length) return; await saveLaw({ name: draft.name, source: OFFICIAL_SOURCE, articles: draft.articles }); setDraft({ name: '', text: '', articles: null }); setMessage('حُفظ النظام في المكتبة.'); await reload(); }
  async function ask() { setImporting(true); try { const token = await getAccessToken(); const dates = Object.fromEntries((laws || []).map((law) => [law.id, importedDate(law)])); const response = await fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ message: query, channel: 'text', legalContext: hitsToLegalContext(hits || [], dates) }) }); const data = await response.json().catch(() => ({})); setAnswer(response.ok ? data.reply : data.message || 'تعذر الحصول على إجابة الآن.'); } finally { setImporting(false); } }
  const search = (event) => { event.preventDefault(); setAnswer(''); setHits(query.trim() ? searchLegal(laws || [], query, { limit: 6 }) : null); };
  const articles = draft.articles; const missing = articles ? missingArticleNumbers(articles) : [];
  return <div className="space-y-4">
    <div><h2 className="text-base font-semibold text-text-primary">المكتبة القانونية</h2><p className="mt-1 text-xs leading-5 text-text-secondary">استورد نص النظام من المصدر الرسمي ({OFFICIAL_SOURCE}) واحفظه على هذا الجهاز للبحث والاستناد إليه.</p></div>
    <div className="space-y-2 rounded-lg border border-base-border bg-base-card p-3"><h3 className="text-xs text-text-secondary">استيراد نظام</h3><div className="flex flex-wrap gap-1.5">{SUGGESTED_LAWS.map((name) => <button key={name} type="button" className={button} onClick={() => setDraft({ ...draft, name })}>{name}</button>)}</div><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="اسم النظام" className={field} /><input type="file" accept=".pdf,.docx,.txt,application/pdf" className="block w-full text-xs text-text-secondary" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} /><textarea rows={4} dir="auto" value={draft.text} placeholder="أو الصق نص النظام هنا" className={`${field} leading-7`} onChange={(e) => setDraft({ ...draft, text: e.target.value, articles: e.target.value.trim() ? parseLawArticles(e.target.value) : null })} />{articles && <p className="text-xs text-text-secondary">عُثر على {articles.length} مادة{missing.length ? `، أرقام مفقودة: ${missing.slice(0, 10).join('، ')}` : ''}.</p>}<button type="button" className={`${primary} w-full`} disabled={!draft.name.trim() || !articles?.length} onClick={save}>حفظ في المكتبة</button></div>
    <form onSubmit={search} className="flex gap-2"><input value={query} onChange={(e) => setQuery(e.target.value)} dir="auto" placeholder="ابحث: مدة الإشعار أو المادة 77" className={`${field} h-10 min-w-0 flex-1`} /><button type="submit" className={button} disabled={!query.trim() || !laws?.length}>بحث</button></form>
    {hits && <div className="space-y-2">{hits.length ? <><button type="button" className={`${button} w-full`} disabled={importing} onClick={ask}>{importing ? 'يجيب…' : 'اسأل المساعد استنادًا إلى المواد'}</button>{answer && <p className="whitespace-pre-line rounded-lg border border-gold/40 bg-base-card p-3 text-sm leading-7" dir="auto">{answer}</p>}{hits.map((hit) => <details key={hit.id} className="rounded-lg border border-base-border bg-base-card p-3"><summary className="cursor-pointer text-sm">{hit.lawName} — {hit.label}</summary><p className="mt-2 whitespace-pre-line text-xs leading-7 text-text-secondary" dir="auto">{hit.text}</p></details>)}</> : <p className="text-xs text-text-secondary">لا توجد مادة مطابقة.</p>}</div>}
    <div className="space-y-2"><h3 className="text-xs text-text-secondary">الأنظمة المستوردة</h3>{laws === null ? <p className="text-sm text-text-secondary">جارٍ التحميل…</p> : laws.length ? laws.map((law) => <div key={law.id} className="flex items-center justify-between gap-2 rounded-lg border border-base-border bg-base-card p-3"><div><span className="block text-sm">{law.name}</span><span className="text-[11px] text-text-secondary">{law.articles.length} مادة · استُورد {importedDate(law)}</span></div><button type="button" className="text-xs text-text-secondary hover:text-red-300" onClick={async () => { if (window.confirm(`حذف «${law.name}»؟`)) { await deleteLaw(law.id); await reload(); } }}>حذف</button></div>) : <p className="text-sm text-text-secondary">لا توجد أنظمة بعد.</p>}</div>
    {message && <p role="status" className="text-xs text-amber-300">{message}</p>}
  </div>;
}
