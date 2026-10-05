'use client';

import { useEffect, useState } from 'react';
import {
  deleteLocalRecord,
  listLocalRecords,
  saveLocalRecord,
} from '../lib/local-data';

const COLLECTIONS = {
  notes: {
    title: 'الملاحظات',
    description: 'ملاحظاتك محفوظة محليًا على هذا الجهاز فقط.',
  },
  tasks: {
    title: 'المهام',
    description: 'مهامك محفوظة محليًا على هذا الجهاز فقط.',
  },
};

export default function LocalDataPanel({ collection }) {
  const config = COLLECTIONS[collection];
  const [records, setRecords] = useState([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    listLocalRecords(collection)
      .then((items) => {
        if (active) setRecords(items);
      })
      .catch((loadError) => {
        console.error(`[${collection}] Could not load local data:`, loadError);
        if (active) setError('تعذر تحميل البيانات المحلية. تحقق من إعدادات التخزين في المتصفح.');
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [collection]);

  async function submitRecord(event) {
    event.preventDefault();
    const normalizedTitle = title.trim();
    const normalizedBody = body.trim();
    if (!normalizedTitle || (collection === 'notes' && !normalizedBody)) return;

    setBusy(true);
    setError('');
    try {
      const record = await saveLocalRecord(collection, {
        title: normalizedTitle,
        ...(collection === 'notes'
          ? { body: normalizedBody }
          : { details: normalizedBody, completed: false }),
      });
      setRecords((current) => [record, ...current]);
      setTitle('');
      setBody('');
    } catch (saveError) {
      console.error(`[${collection}] Could not save local data:`, saveError);
      setError('تعذر حفظ العنصر على هذا الجهاز.');
    } finally {
      setBusy(false);
    }
  }

  async function removeRecord(recordId) {
    setBusy(true);
    setError('');
    try {
      await deleteLocalRecord(collection, recordId);
      setRecords((current) => current.filter((record) => record.id !== recordId));
    } catch (deleteError) {
      console.error(`[${collection}] Could not delete local data:`, deleteError);
      setError('تعذر حذف العنصر من هذا الجهاز.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleTask(record) {
    setBusy(true);
    setError('');
    try {
      const updated = await saveLocalRecord(collection, {
        ...record,
        completed: !record.completed,
      });
      setRecords((current) => current.map((item) => item.id === record.id ? updated : item));
    } catch (saveError) {
      console.error('[tasks] Could not update local task:', saveError);
      setError('تعذر تحديث حالة المهمة.');
    } finally {
      setBusy(false);
    }
  }

  if (!config) return null;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-primary">{config.title}</h2>
        <p className="mt-1 text-xs text-text-secondary">{config.description}</p>
      </div>

      <form onSubmit={submitRecord} className="space-y-3 rounded-lg border border-base-border bg-base-card p-3">
        <label className="block space-y-2">
          <span className="text-sm text-text-primary">العنوان</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={160}
            required
            className="min-h-10 w-full rounded-lg border border-base-border bg-base-panel px-3 text-sm text-text-primary outline-none focus:border-gold/60"
          />
        </label>
        <label className="block space-y-2">
          <span className="text-sm text-text-primary">{collection === 'notes' ? 'المحتوى' : 'تفاصيل (اختياري)'}</span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={5000}
            required={collection === 'notes'}
            rows={3}
            className="w-full rounded-lg border border-base-border bg-base-panel px-3 py-2 text-sm text-text-primary outline-none focus:border-gold/60"
          />
        </label>
        <button
          type="submit"
          disabled={!loaded || busy || !title.trim() || (collection === 'notes' && !body.trim())}
          className="min-h-10 rounded-lg border border-gold/40 px-4 text-sm text-gold hover:bg-gold/10 disabled:opacity-50"
        >
          {busy ? 'جارٍ الحفظ...' : collection === 'notes' ? 'حفظ الملاحظة' : 'إضافة المهمة'}
        </button>
      </form>

      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {!loaded ? (
        <p className="text-sm text-text-secondary">جارٍ تحميل العناصر...</p>
      ) : records.length === 0 ? (
        <p className="rounded-lg border border-base-border bg-base-card px-4 py-5 text-sm text-text-secondary">
          لا توجد عناصر محفوظة حاليًا.
        </p>
      ) : (
        <ul className="space-y-2">
          {records.map((record) => (
            <li key={record.id} className="flex items-start gap-3 rounded-lg border border-base-border bg-base-card p-3">
              {collection === 'tasks' && (
                <input
                  type="checkbox"
                  checked={Boolean(record.completed)}
                  onChange={() => toggleTask(record)}
                  disabled={busy}
                  aria-label={`تحديد المهمة: ${record.title}`}
                  className="mt-1 accent-gold"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className={`break-words text-sm font-medium text-text-primary ${record.completed ? 'line-through opacity-60' : ''}`}>
                  {record.title}
                </p>
                {(record.body || record.details) && (
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-text-secondary">
                    {record.body || record.details}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => removeRecord(record.id)}
                disabled={busy}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-base-panel hover:text-red-300"
                aria-label={`حذف ${collection === 'notes' ? 'الملاحظة' : 'المهمة'}: ${record.title}`}
              >
                حذف
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
