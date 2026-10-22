'use client';

import { useEffect, useState } from 'react';
import { decideComputerTask, dismissComputerTask, subscribeComputerTask } from '../lib/computer-task-flow';

export default function ComputerTaskBanner() {
  const [pending, setPending] = useState(null);
  useEffect(() => subscribeComputerTask(setPending), []);
  if (!pending) return null;

  const { status, description, deviceLabel } = pending;
  return (
    <div role="status" className="mx-4 mb-2 space-y-2 rounded-lg border border-gold/40 bg-gold/5 p-3 text-xs leading-5">
      <p className="text-text-primary">
        {status === 'confirm' && <>مهمة على <strong>{deviceLabel}</strong>: {description} — تحتاج موافقتك</>}
        {status === 'deciding' && 'جارٍ تسجيل قرارك…'}
        {status === 'waiting' && <>بانتظار تنفيذ <strong>{deviceLabel}</strong>: {description}…</>}
        {status === 'done' && <span className="whitespace-pre-wrap" dir="auto">{pending.summary}</span>}
        {status === 'error' && <span className="text-amber-300">{pending.error}</span>}
      </p>
      {status === 'confirm' && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => void decideComputerTask('approved')}
            className="min-h-9 rounded-md bg-gold px-3 text-sm font-semibold text-base-bg">موافقة وتنفيذ</button>
          <button type="button" onClick={() => void decideComputerTask('rejected')}
            className="min-h-9 rounded-md border border-base-border px-3 text-sm text-text-primary">رفض</button>
        </div>
      )}
      {(status === 'waiting' || status === 'done') && (
        <button type="button" onClick={dismissComputerTask}
          className="min-h-8 rounded-md border border-base-border px-3 text-xs text-text-secondary">إخفاء</button>
      )}
    </div>
  );
}
