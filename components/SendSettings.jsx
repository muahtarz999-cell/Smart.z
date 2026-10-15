'use client';

import { useState } from 'react';
import { getActionSettings, saveActionSettings } from '../lib/send-actions';

export default function SendSettings() {
  const [settings, setSettings] = useState(() => getActionSettings());
  const update = (changes) => setSettings(saveActionSettings(changes));

  return (
    <div className="space-y-3 rounded-lg border border-base-border bg-base-card p-3">
      <div>
        <h3 className="text-sm font-medium text-text-primary">الإرسال بأمر صوتي</h3>
        <p className="mt-1 text-xs leading-5 text-text-secondary">
          قل مثلاً «أرسل لأحمد إني بتأخر نص ساعة». يرسل المساعد مباشرة دون سؤال، ويسأل فقط إذا لم يعرف المقصود.
          المجموعات فقط إذا ذكرتها بالاسم، والإرسال لأكثر من 5 أشخاص يحتاج ضغطة تأكيد.
        </p>
      </div>
      <label className="block space-y-1.5">
        <span className="text-xs text-text-secondary">مهلة التراجع قبل الإرسال</span>
        <select value={settings.undoSeconds} onChange={(event) => update({ undoSeconds: Number(event.target.value) })}
          className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-sm text-text-primary">
          <option value={0}>بدون مهلة (إرسال فوري)</option>
          <option value={3}>3 ثوانٍ</option>
          <option value={5}>5 ثوانٍ</option>
          <option value={10}>10 ثوانٍ</option>
        </select>
      </label>
      <label className="flex items-center justify-between gap-3">
        <span className="text-xs leading-5 text-text-secondary">اطلب تأكيدي قبل كل إرسال</span>
        <button type="button" role="switch" aria-checked={settings.confirmEverySend}
          onClick={() => update({ confirmEverySend: !settings.confirmEverySend })}
          className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${settings.confirmEverySend ? 'bg-gold' : 'bg-base-border'}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${settings.confirmEverySend ? 'right-0.5' : 'right-[22px]'}`} />
        </button>
      </label>
      <p className="text-[11px] leading-5 text-text-secondary">قل أو اكتب «تراجع» أثناء المهلة لإلغاء الإرسال.</p>
    </div>
  );
}
