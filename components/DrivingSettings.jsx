'use client';

import { useEffect, useState } from 'react';
import {
  getDrivingSettings,
  getOverlayPermission,
  isNativeDrivingAvailable,
  requestOverlayPermission,
  saveDrivingSettings,
} from '../lib/driving-mode';

function Switch({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${checked ? 'bg-gold' : 'bg-base-border'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${checked ? 'right-0.5' : 'right-[22px]'}`} />
    </button>
  );
}

export default function DrivingSettings({ active = false, onStart, onStop }) {
  const [settings, setSettings] = useState(() => getDrivingSettings());
  const [native, setNative] = useState(false);
  const [overlay, setOverlay] = useState('unsupported');
  const update = (changes) => setSettings(saveDrivingSettings(changes));

  useEffect(() => {
    const available = isNativeDrivingAvailable();
    setNative(available);
    if (!available) return undefined;
    const refresh = () => { getOverlayPermission().then(setOverlay); };
    refresh();
    document.addEventListener('visibilitychange', refresh); // back from Android settings
    return () => document.removeEventListener('visibilitychange', refresh);
  }, []);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-primary">وضع القيادة</h2>
        <p className="mt-1 text-xs leading-5 text-text-secondary">
          تكلّم مع المساعد دون أن تلمس الهاتف.
        </p>
      </div>

      <div className="space-y-2 rounded-lg border border-base-border bg-base-card p-3 text-xs leading-6 text-text-secondary">
        <h3 className="text-sm font-medium text-text-primary">كيف يعمل</h3>
        <p>١. فعّل الخيار أدناه مرة واحدة.</p>
        <p>٢. اضغط زر التحدث وقل <b className="text-text-primary">«وضع القيادة»</b>، أو اضغط «ابدأ الآن».</p>
        <p>٣. بعدها تكلّم متى شئت دون ضغط: يسمعك، يرد بصوته، ثم يعود للاستماع. الميكروفون يُغلق أثناء كلامه حتى لا يرد على نفسه.</p>
        <p>٤. لإيقاف كلامه المس الشاشة{native ? ' أو الفقاعة، أو زر التشغيل في السماعة أو مقود السيارة' : ''}.</p>
        <p>٥. للإنهاء قل <b className="text-text-primary">«وضع القيادة انتهى»</b> أو «وصلت»، أو اضغط «إنهاء». وينتهي وحده بعد {settings.idleMinutes} دقائق بلا كلام.</p>
        <p>الإرسال لشخص أو لمجموعة بالاسم يتم فوراً مع مهلة التراجع. الإرسال لأكثر من 5 أشخاص يُحفظ حتى تؤكده بنفسك حين تتوقف.</p>
        <p className="text-text-primary">
          {native
            ? 'في هذا الهاتف يستمر وضع القيادة والخرائط أو أي تطبيق آخر مفتوح، وحتى مع قفل الشاشة. يظهر إشعار ثابت «Smart.z يستمع» وفيه زر الإنهاء.'
            : 'في هذا الجهاز يعمل وضع القيادة والتطبيق ظاهر على الشاشة، وتبقى الشاشة مضاءة. إذا انتقلت لتطبيق آخر يتوقف الاستماع ويعود حين ترجع.'}
        </p>
      </div>

      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-text-primary">السماح بوضع القيادة</span>
        <Switch label="السماح بوضع القيادة" checked={settings.enabled} onChange={(enabled) => update({ enabled })} />
      </label>

      <label className="block space-y-1.5">
        <span className="text-xs text-text-secondary">الإيقاف التلقائي بعد صمت</span>
        <select value={settings.idleMinutes} onChange={(event) => update({ idleMinutes: Number(event.target.value) })}
          className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-sm text-text-primary">
          <option value={5}>5 دقائق</option>
          <option value={10}>10 دقائق</option>
          <option value={20}>20 دقيقة</option>
          <option value={30}>30 دقيقة</option>
        </select>
      </label>

      {native && (
        <div className="space-y-2 rounded-lg border border-base-border bg-base-card p-3">
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm text-text-primary">فقاعة فوق التطبيقات الأخرى</span>
            <Switch label="فقاعة فوق التطبيقات الأخرى" checked={settings.bubble} onChange={(bubble) => update({ bubble })} />
          </label>
          <p className="text-xs leading-5 text-text-secondary">
            دائرة صغيرة فوق الخرائط تهتز مع الصوت. المسها لإيقاف كلام المساعد، واسحبها إلى أسفل الشاشة لإنهاء وضع القيادة.
          </p>
          {settings.bubble && overlay !== 'granted' && (
            <button type="button" onClick={async () => setOverlay((await requestOverlayPermission()) ? 'granted' : 'denied')}
              className="min-h-10 w-full rounded-lg border border-gold/50 px-3 text-sm text-gold hover:bg-gold/10">
              منح إذن «الظهور فوق التطبيقات الأخرى»
            </button>
          )}
          {settings.bubble && overlay === 'granted' && <p className="text-xs text-emerald-400">إذن الفقاعة ممنوح.</p>}
        </div>
      )}

      {active ? (
        <button type="button" onClick={onStop}
          className="min-h-12 w-full rounded-full bg-red-500 px-5 text-sm font-semibold text-white">
          إنهاء وضع القيادة
        </button>
      ) : (
        <button type="button" disabled={!settings.enabled} onClick={onStart}
          className="min-h-12 w-full rounded-full bg-gold px-5 text-sm font-semibold text-base-bg disabled:opacity-50">
          ابدأ وضع القيادة الآن
        </button>
      )}
    </div>
  );
}
