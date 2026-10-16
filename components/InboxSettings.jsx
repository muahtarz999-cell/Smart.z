'use client';

import { useEffect, useState } from 'react';
import {
  clearInboxMessages,
  countInboxMessages,
  getInboxRetentionDays,
  setInboxRetentionDays,
  syncInbox,
} from '../lib/whatsapp-inbox-store';
import { INBOX_RETENTION_OPTIONS } from '../lib/whatsapp-inbox';

const LABELS = { 1: 'يوم', 3: '3 أيام', 7: 'أسبوع', 14: 'أسبوعان', 30: 'شهر' };

/** Messages kept on this phone for the assistant's reports, and how long they stay. */
export default function InboxSettings({ getAccessToken }) {
  const [days, setDays] = useState(7);
  const [count, setCount] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const refresh = () => countInboxMessages().then(setCount).catch(() => setCount(null));

  useEffect(() => {
    setDays(getInboxRetentionDays());
    refresh();
  }, []);

  async function syncNow() {
    setBusy(true);
    setNotice('');
    const result = await syncInbox(getAccessToken, { force: true });
    await refresh();
    setBusy(false);
    if (result.failed) setNotice('تعذر الوصول إلى الخادم الآن؛ قد يكون نائمًا. أعد المحاولة بعد دقيقة.');
    else if (result.linked === false) setNotice('رقم WhatsApp غير مربوط.');
    else setNotice(result.saved ? `وصلت ${result.saved} رسالة جديدة.` : 'لا رسائل جديدة.');
  }

  async function clearNow() {
    if (!window.confirm('حذف كل رسائل WhatsApp المحفوظة على هذا الهاتف؟')) return;
    await clearInboxMessages();
    await refresh();
    setNotice('حُذفت الرسائل المحفوظة.');
  }

  return (
    <div className="space-y-3 rounded-lg border border-base-border bg-base-card p-3">
      <div>
        <h3 className="text-sm font-medium text-text-primary">تقارير الرسائل</h3>
        <p className="mt-1 text-xs leading-5 text-text-secondary">
          الرسائل الواردة بعد الربط تُحفظ على هذا الهاتف فقط، ليلخّصها المساعد إذا سألته «لخّص رسائلي» أو «مين كلمني اليوم؟».
          لا يحتفظ الخادم بنسخة، وتُحذف هنا تلقائيًا بعد المدة التي تختارها.
        </p>
      </div>
      <label className="flex items-center justify-between gap-3 text-sm text-text-primary">
        <span>مدة الحفظ</span>
        <select
          value={days}
          onChange={(event) => setDays(setInboxRetentionDays(event.target.value))}
          className="h-9 rounded-md border border-base-border bg-base-panel px-2 text-sm text-text-primary"
        >
          {INBOX_RETENTION_OPTIONS.map((option) => (
            <option key={option} value={option}>{LABELS[option] || `${option} يوم`}</option>
          ))}
        </select>
      </label>
      <p className="text-xs text-text-secondary">
        {count === null ? '' : `المحفوظ الآن: ${count} رسالة.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={syncNow}
          className="min-h-9 rounded-lg border border-gold/40 px-3 text-xs text-gold hover:bg-gold/10 disabled:opacity-50"
        >
          {busy ? 'جارٍ الجلب…' : 'جلب الرسائل الآن'}
        </button>
        <button
          type="button"
          onClick={clearNow}
          className="min-h-9 rounded-lg border border-base-border px-3 text-xs text-text-secondary hover:bg-base-panel"
        >
          حذف المحفوظ
        </button>
      </div>
      {notice && <p role="status" className="text-xs leading-5 text-text-secondary">{notice}</p>}
    </div>
  );
}
