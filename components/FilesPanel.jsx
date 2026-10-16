'use client';

import { useEffect, useRef, useState } from 'react';
import FileIntake from './FileIntake';
import {
  deleteFile, formatBytes, hasFileAnalysisConsent, listFiles, renameFile, setFileAnalysisConsent, storageUsage,
} from '../lib/file-store';

const KIND_LABEL = { image: 'صورة', pdf: 'PDF', docx: 'Word', text: 'نص' };

function Thumbnail({ file }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!file.thumbnail) return undefined;
    const objectUrl = URL.createObjectURL(file.thumbnail);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file.thumbnail]);
  return url
    ? <img src={url} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" />
    : <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-base-panel text-[11px] text-text-secondary">{KIND_LABEL[file.kind]}</span>;
}

async function exportFile(file) {
  const blob = file.blob;
  const shareable = new File([blob], file.name, { type: blob.type || file.type || 'application/octet-stream' });
  if (navigator.canShare?.({ files: [shareable] })) {
    try { await navigator.share({ files: [shareable], title: file.name }); return; } catch (error) { if (error?.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function FilesPanel({ onAttach, onStudy }) {
  const [files, setFiles] = useState(null);
  const [usage, setUsage] = useState(null);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [consent, setConsent] = useState(false);
  const intake = useRef(null);

  async function reload() {
    setFiles(await listFiles().catch(() => []));
    setUsage(await storageUsage());
  }

  useEffect(() => { void reload(); setConsent(hasFileAnalysisConsent()); }, []);

  const visible = (files || []).filter((file) => !query.trim() || file.name.includes(query.trim()));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-text-primary">ملفاتي</h2>
        <p className="mt-1 text-xs leading-5 text-text-secondary">محفوظة على هذا الجهاز فقط. عند السؤال عن ملف تُرسل الأجزاء المتعلقة بالسؤال فقط للتحليل، ولا تحفظها Smart.z.</p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[['camera', 'تصوير'], ['gallery', 'صورة'], ['files', 'ملف']].map(([kind, label]) => (
          <button key={kind} type="button" onClick={() => intake.current?.open(kind)}
            className="min-h-10 rounded-lg border border-gold/40 px-2 text-sm text-gold hover:bg-gold/10">{label}</button>
        ))}
      </div>
      <FileIntake ref={intake} multiple onSaved={() => { setMessage(''); void reload(); }} onError={setMessage} />
      {message && <p role="alert" className="text-xs text-amber-300">{message}</p>}

      {usage && (
        <p className={`text-[11px] ${usage.quota && usage.used / usage.quota > 0.8 ? 'text-amber-300' : 'text-text-secondary'}`}>
          المساحة المستخدمة: {formatBytes(usage.used)}{usage.quota ? ` من ${formatBytes(usage.quota)} متاحة للتطبيق` : ''}
        </p>
      )}

      <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="بحث بالاسم"
        className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-sm text-text-primary" />

      {files === null ? (
        <p className="text-sm text-text-secondary">جارٍ التحميل…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-lg border border-base-border bg-base-card px-4 py-5 text-sm text-text-secondary">لا توجد ملفات بعد.</p>
      ) : (
        <ul className="space-y-2">
          {visible.map((file) => (
            <li key={file.id} className="space-y-2 rounded-lg border border-base-border bg-base-card p-3">
              <div className="flex items-center gap-3">
                <Thumbnail file={file} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-text-primary" dir="auto">{file.name}</p>
                  <p className="text-[11px] text-text-secondary">
                    {KIND_LABEL[file.kind]} · {formatBytes(file.size)}{file.pageCount > 1 ? ` · ${file.pageCount} صفحة` : ''}{file.scanned ? ' · ممسوح ضوئياً' : ''}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <button type="button" onClick={() => onAttach?.(file)} className="rounded-md bg-gold/15 px-2.5 py-1.5 text-gold">اسأل عنه</button>
                {file.kind !== 'image' && !file.scanned && (
                  <button type="button" onClick={() => onStudy?.(file)} className="rounded-md border border-base-border px-2.5 py-1.5 text-text-primary">ذاكر منه</button>
                )}
                <button type="button" onClick={() => exportFile(file)} className="rounded-md border border-base-border px-2.5 py-1.5 text-text-primary">تصدير</button>
                <button type="button" onClick={async () => {
                  const name = window.prompt('الاسم الجديد', file.name);
                  if (name) { await renameFile(file.id, name); void reload(); }
                }} className="rounded-md border border-base-border px-2.5 py-1.5 text-text-primary">إعادة تسمية</button>
                <button type="button" onClick={async () => {
                  if (window.confirm(`حذف «${file.name}» من هذا الجهاز؟`)) { await deleteFile(file.id); void reload(); }
                }} className="rounded-md px-2.5 py-1.5 text-text-secondary hover:text-red-300">حذف</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {consent && (
        <button type="button" onClick={() => { setFileAnalysisConsent(false); setConsent(false); }}
          className="text-[11px] text-text-secondary underline-offset-4 hover:underline">
          إلغاء الموافقة المحفوظة على تحليل الملفات (سيُسأل مجدداً)
        </button>
      )}
    </div>
  );
}
