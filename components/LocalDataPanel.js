'use client';

import { useEffect, useState, useMemo } from 'react';
import {
  deleteLocalRecord,
  listLocalRecords,
  saveLocalRecord,
} from '../lib/local-data';

const COLLECTIONS = {
  notes: {
    title: 'الملاحظات',
    description: 'ملاحظاتك محفوظة محليًا على هذا الجهاز فقط.',
    newItemText: 'إضافة ملاحظة جديدة',
    editItemText: 'تعديل الملاحظة',
    saveBtnText: 'حفظ الملاحظة',
    bodyLabel: 'المحتوى',
    searchPlaceholder: 'ابحث في الملاحظات...',
  },
  tasks: {
    title: 'المهام',
    description: 'مهامك محفوظة محليًا على هذا الجهاز فقط.',
    newItemText: 'إضافة مهمة جديدة',
    editItemText: 'تعديل المهمة',
    saveBtnText: 'إضافة المهمة',
    bodyLabel: 'تفاصيل (اختياري)',
    searchPlaceholder: 'ابحث في المهام...',
  },
};

export default function LocalDataPanel({ collection }) {
  const config = COLLECTIONS[collection];
  const [records, setRecords] = useState([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [taskFilter, setTaskFilter] = useState('all'); // 'all' | 'pending' | 'completed'
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

  // Real-time filtered records
  const filteredRecords = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return records.filter((item) => {
      // 1. Task status filter
      if (collection === 'tasks') {
        if (taskFilter === 'pending' && item.completed) return false;
        if (taskFilter === 'completed' && !item.completed) return false;
      }

      // 2. Search query filter
      if (!q) return true;
      const titleMatch = (item.title || '').toLowerCase().includes(q);
      const bodyMatch = (item.body || item.details || '').toLowerCase().includes(q);
      return titleMatch || bodyMatch;
    });
  }, [records, searchQuery, taskFilter, collection]);

  // Start editing a record
  function startEditing(record) {
    setEditingId(record.id);
    setTitle(record.title || '');
    setBody(record.body || record.details || '');
    setError('');
  }

  // Cancel editing
  function cancelEditing() {
    setEditingId(null);
    setTitle('');
    setBody('');
    setError('');
  }

  // Submit (Create or Update)
  async function submitRecord(event) {
    event.preventDefault();
    const normalizedTitle = title.trim();
    const normalizedBody = body.trim();
    if (!normalizedTitle || (collection === 'notes' && !normalizedBody)) return;

    setBusy(true);
    setError('');
    try {
      if (editingId) {
        // Mode: Update Existing
        const existingRecord = records.find((r) => r.id === editingId);
        const updated = await saveLocalRecord(collection, {
          ...existingRecord,
          id: editingId,
          title: normalizedTitle,
          ...(collection === 'notes'
            ? { body: normalizedBody }
            : { details: normalizedBody, completed: existingRecord?.completed ?? false }),
        });

        setRecords((current) =>
          current.map((item) => (item.id === editingId ? updated : item))
        );
        cancelEditing();
      } else {
        // Mode: Create New
        const record = await saveLocalRecord(collection, {
          title: normalizedTitle,
          ...(collection === 'notes'
            ? { body: normalizedBody }
            : { details: normalizedBody, completed: false }),
        });
        setRecords((current) => [record, ...current]);
        setTitle('');
        setBody('');
      }
    } catch (saveError) {
      console.error(`[${collection}] Could not save local data:`, saveError);
      setError('تعذر حفظ العنصر على هذا الجهاز.');
    } finally {
      setBusy(false);
    }
  }

  // Delete Record
  async function removeRecord(recordId) {
    if (!window.confirm('هل أنت متأكد من حذف هذا العنصر؟')) return;
    setBusy(true);
    setError('');
    try {
      await deleteLocalRecord(collection, recordId);
      setRecords((current) => current.filter((record) => record.id !== recordId));
      if (editingId === recordId) {
        cancelEditing();
      }
    } catch (deleteError) {
      console.error(`[${collection}] Could not delete local data:`, deleteError);
      setError('تعذر حذف العنصر من هذا الجهاز.');
    } finally {
      setBusy(false);
    }
  }

  // Toggle Task Completion
  async function toggleTask(record) {
    setBusy(true);
    setError('');
    try {
      const updated = await saveLocalRecord(collection, {
        ...record,
        completed: !record.completed,
      });
      setRecords((current) => current.map((item) => (item.id === record.id ? updated : item)));
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
      {/* Header */}
      <div>
        <h2 className="text-base font-semibold text-text-primary">{config.title}</h2>
        <p className="mt-1 text-xs text-text-secondary">{config.description}</p>
      </div>

      {/* Form: Add or Edit */}
      <form onSubmit={submitRecord} className="space-y-3 rounded-lg border border-base-border bg-base-card p-3.5 transition-all">
        <div className="flex items-center justify-between pb-1 border-b border-base-border/50">
          <span className="text-xs font-semibold text-gold">
            {editingId ? `✏️ ${config.editItemText}` : `➕ ${config.newItemText}`}
          </span>
          {editingId && (
            <button
              type="button"
              onClick={cancelEditing}
              className="text-xs text-text-secondary hover:text-text-primary"
            >
              إلغاء التعديل ✕
            </button>
          )}
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-text-primary">العنوان</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={160}
            required
            placeholder="اكتب العنوان هنا..."
            className="min-h-9 w-full rounded-lg border border-base-border bg-base-panel px-3 text-xs text-text-primary outline-none focus:border-gold/60 focus:ring-1 focus:ring-gold/30"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-text-primary">{config.bodyLabel}</span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={5000}
            required={collection === 'notes'}
            rows={2}
            placeholder="اكتب التفاصيل والمحتوى هنا..."
            className="w-full rounded-lg border border-base-border bg-base-panel px-3 py-2 text-xs text-text-primary outline-none focus:border-gold/60 focus:ring-1 focus:ring-gold/30 resize-none"
          />
        </label>

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={!loaded || busy || !title.trim() || (collection === 'notes' && !body.trim())}
            className="min-h-9 rounded-lg border border-gold/40 bg-gold/10 px-4 text-xs font-medium text-gold hover:bg-gold/20 disabled:opacity-50 transition-colors"
          >
            {busy ? 'جارٍ الحفظ...' : editingId ? 'تحديث وحفظ التعديلات' : config.saveBtnText}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={cancelEditing}
              className="min-h-9 rounded-lg border border-base-border px-3 text-xs text-text-secondary hover:bg-base-panel hover:text-text-primary transition-colors"
            >
              إلغاء
            </button>
          )}
        </div>
      </form>

      {error && <p role="alert" className="text-xs text-red-400 bg-red-500/10 p-2 rounded-lg border border-red-500/20">{error}</p>}

      {/* Search & Filter Bar */}
      {loaded && records.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="relative">
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={config.searchPlaceholder}
              className="w-full rounded-lg border border-base-border bg-base-card py-2 pl-3 pr-8 text-xs text-text-primary placeholder:text-text-secondary/60 outline-none focus:border-gold/50"
            />
            <span className="absolute right-2.5 top-2.5 text-text-secondary">
              🔍
            </span>
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute left-2.5 top-2 text-xs text-text-secondary hover:text-text-primary p-0.5"
                title="مسح البحث"
              >
                ✕
              </button>
            )}
          </div>

          {/* Task Status Filters */}
          {collection === 'tasks' && (
            <div className="flex gap-1.5 pt-0.5">
              {[
                { id: 'all', label: `الكل (${records.length})` },
                { id: 'pending', label: `المتبقية (${records.filter((r) => !r.completed).length})` },
                { id: 'completed', label: `المكتملة (${records.filter((r) => r.completed).length})` },
              ].map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setTaskFilter(filter.id)}
                  className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                    taskFilter === filter.id
                      ? 'bg-gold/15 text-gold border border-gold/40 font-medium'
                      : 'border border-base-border bg-base-panel text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Record List */}
      {!loaded ? (
        <p className="text-xs text-text-secondary animate-pulse">جارٍ تحميل العناصر من التخزين المحلي...</p>
      ) : records.length === 0 ? (
        <p className="rounded-lg border border-base-border bg-base-card px-4 py-6 text-center text-xs text-text-secondary">
          لا توجد عناصر محفوظة حاليًا على هذا الجهاز.
        </p>
      ) : filteredRecords.length === 0 ? (
        <p className="rounded-lg border border-base-border bg-base-card px-4 py-5 text-center text-xs text-text-secondary">
          لا توجد نتائج تطابق بحثك «{searchQuery}».
        </p>
      ) : (
        <ul className="space-y-2">
          {filteredRecords.map((record) => (
            <li
              key={record.id}
              className={`flex items-start gap-3 rounded-lg border p-3 transition-all ${
                editingId === record.id
                  ? 'border-gold/60 bg-gold/5 shadow-sm'
                  : 'border-base-border bg-base-card hover:border-base-border/80'
              }`}
            >
              {collection === 'tasks' && (
                <input
                  type="checkbox"
                  checked={Boolean(record.completed)}
                  onChange={() => toggleTask(record)}
                  disabled={busy}
                  aria-label={`تحديد المهمة: ${record.title}`}
                  className="mt-1 h-4 w-4 accent-gold cursor-pointer"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className={`break-words text-xs font-semibold text-text-primary ${record.completed ? 'line-through opacity-50' : ''}`}>
                  {record.title}
                </p>
                {(record.body || record.details) && (
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-text-secondary">
                    {record.body || record.details}
                  </p>
                )}
                <span className="mt-1.5 block text-[10px] text-text-secondary/70 font-mono">
                  {new Date(record.updatedAt || record.createdAt).toLocaleDateString('ar-EG', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => startEditing(record)}
                  disabled={busy}
                  className="rounded-md border border-base-border bg-base-panel px-2 py-1 text-[11px] text-text-secondary hover:text-gold hover:border-gold/30 transition-colors"
                  aria-label={`تعديل: ${record.title}`}
                >
                  تعديل
                </button>
                <button
                  type="button"
                  onClick={() => removeRecord(record.id)}
                  disabled={busy}
                  className="rounded-md border border-base-border bg-base-panel px-2 py-1 text-[11px] text-text-secondary hover:text-red-400 hover:border-red-500/30 transition-colors"
                  aria-label={`حذف: ${record.title}`}
                >
                  حذف
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
