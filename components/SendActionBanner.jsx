'use client';

import { useEffect, useState } from 'react';
import { cancelPendingSend, confirmPendingSend, subscribe } from '../lib/send-actions';

function recipientsLabel(recipients = []) {
  const names = recipients.map((r) => (r.isGroup ? `مجموعة ${r.name}` : r.name));
  return names.length > 3 ? `${names.slice(0, 3).join('، ')} و${names.length - 3} آخرين` : names.join('، ');
}

export default function SendActionBanner() {
  const [pending, setPending] = useState(null);
  useEffect(() => subscribe(setPending), []);
  if (!pending) return null;

  const { action, status } = pending;
  const individuals = action.recipients.filter((r) => !r.isGroup).length;

  return (
    <div role="status" className="mx-4 mb-2 space-y-2 rounded-lg border border-gold/40 bg-gold/5 p-3 text-xs leading-5">
      <p className="text-text-primary">
        {status === 'counting' && <>يُرسل إلى <strong>{recipientsLabel(action.recipients)}</strong> خلال {pending.secondsLeft} ث</>}
        {status === 'confirm' && <>إرسال إلى <strong>{individuals > 5 ? `${individuals} أشخاص` : recipientsLabel(action.recipients)}</strong> — يحتاج تأكيدك</>}
        {status === 'sending' && 'جارٍ الإرسال…'}
        {status === 'sent' && <>أُرسلت إلى {recipientsLabel(action.recipients)} ✓</>}
        {status === 'failed' && <span className="text-amber-300">{pending.error}</span>}
        {status === 'cancelled' && 'أُلغي الإرسال.'}
      </p>
      {(status === 'counting' || status === 'confirm') && (
        <p className="line-clamp-3 text-text-secondary" dir="auto">«{action.text}»</p>
      )}
      {status === 'counting' && (
        <button type="button" onClick={cancelPendingSend}
          className="min-h-9 w-full rounded-md border border-base-border px-3 text-sm text-text-primary">تراجع</button>
      )}
      {status === 'confirm' && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={confirmPendingSend}
            className="min-h-9 rounded-md bg-gold px-3 text-sm font-semibold text-base-bg">تأكيد الإرسال</button>
          <button type="button" onClick={cancelPendingSend}
            className="min-h-9 rounded-md border border-base-border px-3 text-sm text-text-primary">إلغاء</button>
        </div>
      )}
    </div>
  );
}
