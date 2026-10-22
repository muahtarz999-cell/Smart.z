'use client';

import { useEffect, useState } from 'react';
import {
  callAssistantAvailable,
  getCallAssistantStatus,
  requestCallAssistantPermissions,
  setCallAssistantEnabled,
  setCallAssistantMessage,
} from '../lib/call-assistant';
import ReceptionistSettings from './ReceptionistSettings';

/** «المكالمات»: switch the call assistant on or off. Always on while driving mode runs. */
export default function CallSettings({ onOpenWhatsApp, getAccessToken }) {
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const native = callAssistantAvailable();
    setAvailable(native);
    if (native) void getCallAssistantStatus().then(setStatus);
  }, []);

  async function run(task) {
    setBusy(true);
    setError('');
    try {
      setStatus(await task());
      return true;
    } catch (failure) {
      setError(failure?.message || 'تعذر حفظ الإعداد.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const enabled = status?.enabled === true;
  const missingPermission = status && !status.callsPermission;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-text-primary">المكالمات</h2>
        <p className="mt-1 text-xs leading-5 text-text-secondary">
          عند اتصال أحد يقول المساعد اسم المتصل، وتستطيع الرد أو الرفض أو الرفض مع رسالة. لا يستطيع التطبيق التحدث مع المتصل؛ عند الرد تتحدث أنت.
        </p>
      </div>

      {!available ? (
        <p className="rounded-lg border border-base-border bg-base-card p-3 text-xs leading-5 text-text-secondary">
          مساعد مكالمات الهاتف متاح في تطبيق Smart.z على أندرويد فقط.
        </p>
      ) : (
        <section className="space-y-3">
          <label className="flex items-center justify-between gap-3 rounded-lg border border-base-border p-3">
            <span className="text-xs leading-5 text-text-secondary">
              <span className="block text-sm text-text-primary">مساعد المكالمات</span>
              يعلن المتصل ويظهر إشعار بأزرار «رد» و«رفض» و«رفض برسالة».
            </span>
            <button type="button" role="switch" aria-checked={enabled} disabled={busy || !status}
              onClick={() => void run(() => setCallAssistantEnabled(!enabled))}
              className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${enabled ? 'bg-gold' : 'bg-base-border'}`}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${enabled ? 'right-0.5' : 'right-[22px]'}`} />
            </button>
          </label>

          <p className="rounded-lg border border-gold/30 bg-gold/5 p-3 text-xs leading-5 text-text-secondary">
            🚗 <strong className="text-text-primary">في وضع القيادة يعمل دائمًا</strong> حتى لو كان المفتاح مطفأً: يعلن المتصل بصوته، وتقول «رد» أو «ارفض» أو «ارفض وقل له إني أسوق». ترسل الرسالة في واتساب إذا كان مربوطًا، ويتوقف الاستماع أثناء المكالمة.
          </p>

          {missingPermission && (
            <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs leading-5">
              <p className="text-text-primary">يحتاج إذن «الهاتف» و«سجل المكالمات» لمعرفة المتصل والرد والرفض، و«جهات الاتصال» لقول اسمه.</p>
              <button type="button" disabled={busy} onClick={() => void run(requestCallAssistantPermissions)}
                className="min-h-9 w-full rounded-md bg-gold px-3 text-sm font-semibold text-base-bg disabled:opacity-60">منح الأذونات</button>
            </div>
          )}

          <label className="block space-y-1.5 rounded-lg border border-base-border p-3">
            <span className="text-xs text-text-secondary">رسالة «رفض برسالة» (تفتح جاهزة في الرسائل وتضغط إرسال)</span>
            <textarea rows={2} maxLength={300} dir="auto"
              value={draft ?? (status?.message || '')}
              placeholder="مشغول الآن، سأتواصل معك لاحقًا."
              onChange={(event) => setDraft(event.target.value)}
              className="w-full rounded-md border border-base-border bg-base-panel px-3 py-2 text-sm text-text-primary" />
            <button type="button" disabled={busy || draft === null}
              onClick={async () => { if (await run(() => setCallAssistantMessage(draft))) setDraft(null); }}
              className="min-h-9 w-full rounded-md border border-gold/40 px-3 text-xs text-gold disabled:opacity-50">حفظ الرسالة</button>
          </label>
        </section>
      )}

      <section className="space-y-2 border-t border-base-border pt-5">
        <h3 className="text-sm font-semibold text-text-primary">مكالمات واتساب</h3>
        <p className="text-xs leading-5 text-text-secondary">
          رفض مكالمات واتساب تلقائيًا مع رسالة يُضبط من «ربط التطبيقات ← WhatsApp»، ويعمل دائمًا أثناء وضع القيادة إذا كان واتساب مربوطًا.
        </p>
        {onOpenWhatsApp && (
          <button type="button" onClick={onOpenWhatsApp}
            className="min-h-9 rounded-md border border-base-border px-3 text-xs text-text-primary">فتح إعدادات واتساب</button>
        )}
      </section>

      {getAccessToken && <ReceptionistSettings getAccessToken={getAccessToken} />}

      {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
    </div>
  );
}
