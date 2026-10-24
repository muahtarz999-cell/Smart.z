'use client';

import { useCallback, useEffect, useState } from 'react';

const FORWARDING = [
  ['**61*', 'عند عدم الرد'],
  ['**67*', 'عند الانشغال أو الرفض'],
  ['**62*', 'عند الإغلاق أو خارج التغطية'],
];

function formatTime(value) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return value;
  }
}

function Switch({ checked, disabled, onClick, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onClick}
      className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-gold' : 'bg-base-border'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${checked ? 'right-0.5' : 'right-[22px]'}`} />
    </button>
  );
}

/** «موظف الاستقبال الذكي»: answers forwarded phone calls and, with a Meta business number, WhatsApp calls. */
export default function ReceptionistSettings({ getAccessToken }) {
  const [state, setState] = useState(null); // { settings, phoneNumbers, whatsappNumber, configured }
  const [draft, setDraft] = useState(null);
  const [business, setBusiness] = useState(null); // Meta business connection or null
  const [calls, setCalls] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const api = useCallback(async (url, init = {}) => {
    const token = await getAccessToken();
    if (!token) throw new Error('انتهت جلسة الدخول.');
    const response = await fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'تعذر الاتصال بالخدمة.');
    return data;
  }, [getAccessToken]);

  const load = useCallback(async () => {
    try {
      const [settings, connection, log] = await Promise.all([
        api('/api/receptionist/settings'),
        api('/api/whatsapp/connection').catch(() => ({ connection: null })),
        api('/api/receptionist/calls').catch(() => ({ calls: [] })),
      ]);
      setState(settings);
      setBusiness(connection.connection || null);
      setCalls(Array.isArray(log.calls) ? log.calls : []);
    } catch (failure) {
      setError(failure.message);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  async function save(changes) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setState(await api('/api/receptionist/settings', { method: 'POST', body: JSON.stringify(changes) }));
      setDraft(null);
      setNotice('حُفظت الإعدادات.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleWhatsApp() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/api/receptionist/whatsapp', { method: 'POST', body: JSON.stringify({ enabled: !state.settings.whatsappEnabled }) });
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function clearLog() {
    if (!window.confirm('مسح سجل المكالمات كله؟')) return;
    try {
      await api('/api/receptionist/calls', { method: 'DELETE' });
      setCalls([]);
    } catch (failure) {
      setError(failure.message);
    }
  }

  if (!state) {
    return <p className="text-xs text-text-secondary">{error || 'جارٍ تحميل موظف الاستقبال…'}</p>;
  }

  const settings = state.settings;
  const form = draft ?? {
    ownerName: settings.ownerName,
    greeting: settings.greeting,
    knowledge: settings.knowledge,
    vipNumbers: settings.vipNumbers.join('\n'),
    transferNumber: settings.transferNumber,
  };
  const edit = (key) => (event) => setDraft({ ...form, [key]: event.target.value });
  const field = 'w-full rounded-md border border-base-border bg-base-panel px-3 py-2 text-sm text-text-primary';
  const number = state.phoneNumbers[0];

  return (
    <section className="space-y-4 border-t border-base-border pt-5">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">موظف الاستقبال الذكي</h3>
        <p className="mt-1 text-xs leading-5 text-text-secondary">
          يرد بصوته على المكالمات التي لم تستطع الرد عليها: يعرّف بنفسه أنه مساعد آلي، ويفهم المتصل، ويجيب مما تسمح به، ويأخذ رسالته، ثم يصلك ملخص هنا.
          المكالمات العاجلة تصلك فورًا في واتساب.
        </p>
      </div>

      {!state.configured && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs leading-5 text-text-primary">
          الخدمة لم تُجهَّز بعد على الخادم (مفتاح OpenAI). ستعمل بعد إكمال خطوات النشر.
        </p>
      )}

      <label className="flex items-center justify-between gap-3 rounded-lg border border-base-border p-3">
        <span className="text-xs leading-5 text-text-secondary">
          <span className="block text-sm text-text-primary">الرد على مكالماتي المحوّلة</span>
          {number ? `رقم الاستقبال الخاص بك: ${number}` : 'لم يُعيَّن لك رقم استقبال بعد؛ تواصل مع الإدارة.'}
        </span>
        <Switch checked={settings.enabled} disabled={busy} label="الرد على مكالماتي المحوّلة"
          onClick={() => void save({ enabled: !settings.enabled })} />
      </label>

      {number && (
        <div className="space-y-2 rounded-lg border border-base-border bg-base-card p-3 text-xs leading-5 text-text-secondary">
          <p className="text-text-primary">فعّل التحويل من جوالك مرة واحدة (اطلب الكود كأنه رقم):</p>
          <ul className="space-y-1" dir="ltr">
            {FORWARDING.map(([code, when]) => (
              <li key={code} className="flex justify-between gap-2">
                <span className="font-mono text-gold">{`${code}+${number}#`}</span>
                <span dir="rtl">{when}</span>
              </li>
            ))}
          </ul>
          <p>لإلغاء كل التحويلات: <span className="font-mono text-gold" dir="ltr">##002#</span>. وعندما ترفض مكالمة، تذهب لموظف الاستقبال بدل أن تنقطع.</p>
        </div>
      )}

      {business && (
        <label className="flex items-center justify-between gap-3 rounded-lg border border-base-border p-3">
          <span className="text-xs leading-5 text-text-secondary">
            <span className="block text-sm text-text-primary">الرد على مكالمات واتساب للأعمال</span>
            رقم الأعمال {business.displayPhoneNumber}: يفعّل التطبيق المكالمات عند Meta ويرد عليها موظف الاستقبال. لا يوجد تحويل داخل واتساب؛ العاجل يصلك تنبيهًا.
          </span>
          <Switch checked={settings.whatsappEnabled} disabled={busy} label="الرد على مكالمات واتساب للأعمال" onClick={() => void toggleWhatsApp()} />
        </label>
      )}

      <form className="space-y-3 rounded-lg border border-base-border p-3" onSubmit={(event) => {
        event.preventDefault();
        void save({ ...form, vipNumbers: form.vipNumbers.split(/[\s,،]+/).filter(Boolean) });
      }}>
        <label className="block space-y-1">
          <span className="text-xs text-text-secondary">اسمك كما يذكره للمتصلين</span>
          <input className={field} maxLength={60} value={form.ownerName} onChange={edit('ownerName')} placeholder="زياد" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-text-secondary">الترحيب (اختياري)</span>
          <textarea className={field} rows={2} maxLength={300} value={form.greeting} onChange={edit('greeting')}
            placeholder="أهلًا، معك المساعد الآلي لزياد، هو مشغول الآن. كيف أقدر أخدمك؟" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-text-secondary">ما يُسمح له بقوله (دوام، عنوان، خدمات…). لا يقول شيئًا غيره.</span>
          <textarea className={field} rows={4} maxLength={4000} value={form.knowledge} onChange={edit('knowledge')} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-text-secondary">رقمك الحقيقي لتحويل الطوارئ (دولي، اختياري)</span>
          <input className={field} dir="ltr" inputMode="numeric" value={form.transferNumber} onChange={edit('transferNumber')} placeholder="9665XXXXXXXX" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-text-secondary">أرقام مهمة يعرض عليها التحويل إليك مباشرة (رقم في كل سطر)</span>
          <textarea className={field} rows={3} dir="ltr" value={form.vipNumbers} onChange={edit('vipNumbers')} />
        </label>
        <button type="submit" disabled={busy || draft === null}
          className="min-h-9 w-full rounded-md bg-gold px-3 text-sm font-semibold text-base-bg disabled:opacity-50">حفظ</button>
      </form>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm text-text-primary">المكالمات التي رد عليها</h4>
          <div className="flex gap-2">
            <button type="button" onClick={() => void load()} className="text-xs text-gold">تحديث</button>
            {calls.length > 0 && <button type="button" onClick={() => void clearLog()} className="text-xs text-text-secondary">مسح</button>}
          </div>
        </div>
        {calls.length === 0 ? (
          <p className="text-xs text-text-secondary">لا توجد مكالمات بعد.</p>
        ) : (
          <ul className="space-y-2">
            {calls.map((call) => (
              <li key={call.id} className={`rounded-lg border p-3 text-xs leading-5 ${call.urgent ? 'border-red-500/50 bg-red-500/5' : 'border-base-border'}`}>
                <div className="flex justify-between gap-2 text-text-secondary">
                  <span>
                    {call.urgent && <strong className="text-red-300">عاجل · </strong>}
                    {call.channel === 'whatsapp' ? 'واتساب' : 'هاتف'} · {call.caller_name || 'متصل'}
                    {call.caller_number && <span dir="ltr"> {call.caller_number}</span>}
                  </span>
                  <span>{formatTime(call.started_at || call.created_at)}</span>
                </div>
                <p className="mt-1 text-sm text-text-primary" dir="auto">{call.summary}</p>
                {call.callback_number && <p className="mt-1 text-text-secondary">رقم للعودة: <span dir="ltr">{call.callback_number}</span></p>}
                {call.transferred && <p className="mt-1 text-gold">حُوّلت المكالمة إليك.</p>}
                {call.caller_number && (
                  <a href={`tel:+${call.callback_number || call.caller_number}`} className="mt-2 inline-block text-gold">اتصل به</a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
      {notice && <p role="status" className="text-xs text-emerald-300">{notice}</p>}
    </section>
  );
}
