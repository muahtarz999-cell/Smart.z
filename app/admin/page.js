'use client';

/**
 * Hidden admin panel (owner decision, 2026-10-16): smart-z.pages.dev/admin, browser only.
 * Not linked from anywhere; the real protection is the server, which accepts only the
 * e-mails in ADMIN_EMAILS. Customer data stays on customers' phones: this page sees only
 * the account (e-mail, status, device bound or not, WhatsApp node).
 */

import { useCallback, useEffect, useState } from 'react';
import { isSupabaseConfigured, supabase } from '../../lib/supabase';
import { generatePassword, MIN_PASSWORD_LENGTH } from '../../lib/admin';

const input = 'h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-left text-sm text-text-primary';
const button = 'h-9 rounded-md border px-3 text-sm disabled:opacity-50';
const primary = `${button} border-gold bg-gold/15 text-gold-light`;
const plain = `${button} border-base-border text-text-primary hover:bg-base-panel`;
const danger = `${button} border-red-500/40 text-red-300 hover:bg-red-500/10`;

const ACTION_CONFIRM = {
  suspend: 'إيقاف هذا العميل؟ يُسجَّل خروجه ويُفصل واتساب الخاص به.',
  delete: 'حذف هذا العميل نهائياً؟ لا يمكن التراجع، ويُفصل واتساب الخاص به.',
  reset_device: 'فك ربط الجهاز؟ أول جهاز يدخل بعدها يصبح جهاز هذا الحساب.',
  disconnect_whatsapp: 'فصل واتساب هذا العميل؟ سيحتاج لإعادة الربط من هاتفه.',
};

const DONE = {
  create: 'أُضيف العميل. أعطه البريد وكلمة المرور.',
  suspend: 'أُوقف العميل.',
  activate: 'فُعّل العميل.',
  set_computer_pairing: null,
  reset_device: 'فُك ربط الجهاز.',
  set_password: 'تغيّرت كلمة المرور.',
  disconnect_whatsapp: 'فُصل واتساب.',
  set_receptionist_numbers: 'حُفظت أرقام موظف الاستقبال.',
  delete: 'حُذف العميل.',
};

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('ar-SA-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return value;
  }
}

function isNativeApp() {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

export default function AdminPage() {
  const [native, setNative] = useState(false);
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [customers, setCustomers] = useState(null);
  const [capacity, setCapacity] = useState(null);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordFor, setPasswordFor] = useState(null);
  const [passwordValue, setPasswordValue] = useState('');

  useEffect(() => {
    setNative(isNativeApp());
    if (!supabase) {
      setReady(true);
      return undefined;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session || null);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next || null));
    return () => data.subscription.unsubscribe();
  }, []);

  const call = useCallback(async (init = {}) => {
    const { data } = await supabase.auth.getSession(); // fresh token on every call
    const token = data.session?.access_token;
    if (!token) throw new Error('انتهت الجلسة. سجّل الدخول مرة أخرى.');
    const response = await fetch('/api/admin/customers', {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || 'تعذر الاتصال بالخادم.');
    return result;
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await call();
      setCustomers(result.customers);
      setCapacity(result.whatsappCapacity);
    } catch (loadError) {
      setCustomers(null);
      setError(loadError.message);
    }
  }, [call]);

  useEffect(() => {
    if (session && !native) load();
  }, [session?.access_token, native, load]); // eslint-disable-line react-hooks/exhaustive-deps

  async function signIn(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (signInError) throw signInError;
      setPassword('');
    } catch (signInError) {
      setError(signInError?.message || 'تعذر تسجيل الدخول.');
    } finally {
      setBusy(false);
    }
  }

  async function run(action, payload = {}) {
    if (ACTION_CONFIRM[action] && !window.confirm(ACTION_CONFIRM[action])) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await call({ method: 'POST', body: JSON.stringify({ action, ...payload }) });
      let message = action === 'set_computer_pairing'
        ? (result.allowComputerPairing ? 'سُمِح لهذا العميل بإنشاء اقتران كمبيوتر جديد.' : 'مُنِع هذا العميل من إنشاء اقتران كمبيوتر جديد.')
        : DONE[action];
      if (result.whatsapp?.released && result.whatsapp.nodeWiped === false) {
        message += ' تنبيه: تعذر مسح جلسة الخادم الآن؛ ستُمسح عند الحجز التالي.';
      }
      setNotice(message);
      if (action === 'create') {
        setNewEmail('');
        setNewPassword('');
      }
      if (action === 'set_password') {
        setPasswordFor(null);
        setPasswordValue('');
      }
      await load();
    } catch (runError) {
      setError(runError.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice('نُسخ.');
    } catch {
      setNotice(text);
    }
  }

  let content;
  if (native) {
    content = <p className="text-text-secondary">لوحة الإدارة تعمل من متصفح الكمبيوتر أو الجوال فقط، وليس من داخل التطبيق.</p>;
  } else if (!isSupabaseConfigured) {
    content = <p className="text-text-secondary">Supabase غير مضبوط في بيئة التشغيل.</p>;
  } else if (!ready) {
    content = <p className="text-text-secondary">جارٍ التحميل…</p>;
  } else if (!session) {
    content = (
      <form onSubmit={signIn} className="mx-auto max-w-sm space-y-3">
        <input type="email" required autoComplete="email" placeholder="البريد" value={email}
          onChange={(event) => setEmail(event.target.value)} className={input} dir="ltr" />
        <input type="password" required autoComplete="current-password" placeholder="كلمة المرور" value={password}
          onChange={(event) => setPassword(event.target.value)} className={input} dir="ltr" />
        <button type="submit" disabled={busy} className={`${primary} w-full`}>دخول</button>
      </form>
    );
  } else {
    content = (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-secondary">
          <span dir="ltr">{session.user?.email}</span>
          <div className="flex gap-2">
            <button type="button" className={plain} disabled={busy} onClick={load}>تحديث</button>
            <button type="button" className={plain} onClick={() => supabase.auth.signOut()}>خروج</button>
          </div>
        </div>

        <section className="rounded-lg border border-base-border bg-base-card p-4">
          <h2 className="mb-3 font-semibold text-text-primary">إضافة عميل</h2>
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
            onSubmit={(event) => { event.preventDefault(); run('create', { email: newEmail, password: newPassword }); }}
          >
            <input type="email" required placeholder="بريد العميل" value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)} className={input} dir="ltr" autoComplete="off" />
            <div className="flex gap-2">
              <input type="text" required minLength={MIN_PASSWORD_LENGTH} placeholder="كلمة المرور" value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)} className={input} dir="ltr" autoComplete="new-password" />
              <button type="button" className={plain} onClick={() => setNewPassword(generatePassword())}>توليد</button>
            </div>
            <button type="submit" disabled={busy} className={primary}>حفظ</button>
          </form>
          {newEmail && newPassword && (
            <button type="button" className="mt-2 text-xs text-gold" onClick={() => copy(`${newEmail}\n${newPassword}`)}>
              نسخ البريد وكلمة المرور لإرسالهما للعميل
            </button>
          )}
        </section>

        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="font-semibold text-text-primary">العملاء {customers ? `(${customers.length})` : ''}</h2>
            {capacity && <span className="text-xs text-text-secondary">خوادم واتساب: {capacity.used} من {capacity.total}</span>}
          </div>
          {!customers && !error && <p className="text-text-secondary">جارٍ التحميل…</p>}
          <div className="space-y-3">
            {customers?.map((customer) => (
              <article key={customer.id} className="rounded-lg border border-base-border bg-base-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-text-primary" dir="ltr">{customer.email}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${customer.active ? 'border-emerald-500/40 text-emerald-300' : 'border-red-500/40 text-red-300'}`}>
                    {customer.active ? 'فعّال' : 'موقوف'}{customer.isSelf ? ' · أنت' : ''}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-secondary sm:grid-cols-5">
                  <div><dt className="inline">أُضيف: </dt><dd className="inline">{formatDate(customer.createdAt)}</dd></div>
                  <div><dt className="inline">آخر دخول: </dt><dd className="inline">{formatDate(customer.lastSignInAt)}</dd></div>
                  <div><dt className="inline">الجهاز: </dt><dd className="inline">{customer.deviceBound ? `مرتبط منذ ${formatDate(customer.deviceBoundAt)}` : 'غير مرتبط'}</dd></div>
                  <div><dt className="inline">واتساب: </dt><dd className="inline">{customer.whatsappNode ? `خادم ${customer.whatsappNode} (${customer.whatsappStatus})` : '—'}</dd></div>
                  <div><dt className="inline">رقم موظف الاستقبال: </dt><dd className="inline" dir="ltr">{customer.receptionistNumbers?.length ? customer.receptionistNumbers.join('، ') : '—'}</dd></div>
                  <div>
                    <dt className="inline">اقتران الكمبيوتر: </dt>
                    <dd className={customer.allowComputerPairing ? 'inline text-emerald-300' : 'inline text-text-secondary'}>
                      {customer.allowComputerPairing ? 'مسموح' : 'ممنوع'}
                    </dd>
                  </div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2">
                  {customer.active
                    ? !customer.isSelf && <button type="button" className={plain} disabled={busy} onClick={() => run('suspend', { userId: customer.id })}>إيقاف</button>
                    : <button type="button" className={plain} disabled={busy} onClick={() => run('activate', { userId: customer.id })}>تفعيل</button>}
                  {customer.deviceBound && (
                    <button type="button" className={plain} disabled={busy} onClick={() => run('reset_device', { userId: customer.id })}>فك ربط الجهاز</button>
                  )}
                  <button type="button" className={customer.allowComputerPairing ? danger : plain} disabled={busy}
                    aria-pressed={customer.allowComputerPairing}
                    onClick={() => run('set_computer_pairing', {
                      userId: customer.id,
                      allowComputerPairing: !customer.allowComputerPairing,
                    })}>
                    {customer.allowComputerPairing ? 'إيقاف اقتران الكمبيوتر' : 'السماح باقتران كمبيوتر'}
                  </button>
                  <button type="button" className={plain} disabled={busy}
                    onClick={() => { setPasswordFor(passwordFor === customer.id ? null : customer.id); setPasswordValue(''); }}>
                    كلمة مرور جديدة
                  </button>
                  {customer.whatsappNode && (
                    <button type="button" className={plain} disabled={busy} onClick={() => run('disconnect_whatsapp', { userId: customer.id })}>فصل واتساب</button>
                  )}
                  <button type="button" className={plain} disabled={busy}
                    onClick={() => {
                      const current = (customer.receptionistNumbers || []).join(', ');
                      const value = window.prompt('أرقام المزود لموظف الاستقبال (دولية، مفصولة بفواصل). اتركه فارغًا للإزالة:', current);
                      if (value === null) return;
                      run('set_receptionist_numbers', { userId: customer.id, numbers: value.split(/[\s,،]+/).filter(Boolean) });
                    }}>
                    رقم موظف الاستقبال
                  </button>
                  {!customer.isSelf && (
                    <button type="button" className={danger} disabled={busy} onClick={() => run('delete', { userId: customer.id })}>حذف</button>
                  )}
                </div>
                {passwordFor === customer.id && (
                  <form className="mt-3 flex flex-wrap gap-2"
                    onSubmit={(event) => { event.preventDefault(); run('set_password', { userId: customer.id, password: passwordValue }); }}>
                    <input type="text" required minLength={MIN_PASSWORD_LENGTH} value={passwordValue} placeholder="كلمة المرور الجديدة"
                      onChange={(event) => setPasswordValue(event.target.value)} className={`${input} max-w-xs`} dir="ltr" autoComplete="new-password" />
                    <button type="button" className={plain} onClick={() => setPasswordValue(generatePassword())}>توليد</button>
                    <button type="submit" className={primary} disabled={busy}>حفظ</button>
                    {passwordValue && <button type="button" className={plain} onClick={() => copy(passwordValue)}>نسخ</button>}
                  </form>
                )}
              </article>
            ))}
          </div>
        </section>
      </div>
    );
  }

  return (
    <main dir="rtl" className="min-h-screen bg-base-bg px-4 py-8 text-text-primary">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-6 text-xl font-semibold text-gold-light">Smart.z · الإدارة</h1>
        {error && <p role="alert" className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
        {notice && <p role="status" className="mb-4 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200">{notice}</p>}
        {content}
      </div>
    </main>
  );
}
