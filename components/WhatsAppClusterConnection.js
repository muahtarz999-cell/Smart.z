'use client';

/**
 * WhatsApp linking, two paths:
 *   - Personal (Baileys on a Render node): QR on a computer, pairing code on the phone.
 *   - Business (Meta Cloud API): official embedded signup, handled by the page (onStartMeta).
 *
 * The personal flow keeps polling while the node wakes up (Render free
 * instances sleep and take up to a minute) and refreshes the QR as WhatsApp
 * rotates it (~every 20 s). A "pending" answer is never treated as failure.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_MS = 3000;
const WAIT_LIMIT_MS = 3 * 60 * 1000;

const STATUS_TEXT = {
  CONNECTED: 'متصل',
  WAITING_QR: 'بانتظار المسح',
  CONNECTING: 'جارٍ الاتصال…',
  STARTING: 'جارٍ التجهيز…',
  WAKING: 'الخادم يستيقظ…',
  IDLE: 'غير متصل',
  DISCONNECTED: 'غير متصل',
  ERROR: 'خطأ',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function WhatsAppClusterConnection({
  getAccessToken,
  eligible,
  metaConnection,
  metaBusy,
  metaError,
  onStartMeta,
}) {
  const [path, setPath] = useState('personal'); // personal | business
  const [method, setMethod] = useState('pairing'); // pairing (phone) | qr (computer)
  const [phoneNumber, setPhoneNumber] = useState('');
  const [status, setStatus] = useState({ status: 'DISCONNECTED', connected: false, assigned: false, autoReply: false });
  const [qr, setQr] = useState(null);
  const [pairingCode, setPairingCode] = useState(null);
  const [waiting, setWaiting] = useState(false);
  const [waitNote, setWaitNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const runRef = useRef(0); // increments to cancel any running wait loop

  const api = useCallback(async (url, init = {}) => {
    const token = await getAccessToken();
    if (!token) throw new Error('انتهت جلسة الدخول. سجّل الدخول مرة أخرى.');
    const response = await fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, data };
  }, [getAccessToken]);

  const refreshStatus = useCallback(async () => {
    const result = await api('/api/whatsapp/cluster/status');
    if (result.ok || result.data?.status) setStatus((current) => ({ ...current, ...result.data }));
    return result.data;
  }, [api]);

  useEffect(() => {
    if (!eligible) return undefined;
    refreshStatus().catch(() => {});
    return () => { runRef.current += 1; };
  }, [eligible, refreshStatus]);

  async function waitForLink(kind) {
    const run = ++runRef.current;
    const started = Date.now();
    setWaiting(true);
    setError('');
    setQr(null);
    setPairingCode(null);
    setWaitNote('جارٍ تجهيز الخادم…');
    const digits = phoneNumber.replace(/\D/g, '');
    let codeShown = false;

    try {
      while (run === runRef.current && Date.now() - started < WAIT_LIMIT_MS) {
        if (kind === 'qr' || !codeShown) {
          const query = kind === 'qr' ? 'method=qr' : `method=pairing_code&phoneNumber=${encodeURIComponent(digits)}`;
          const { ok, status: httpStatus, data } = await api(`/api/whatsapp/cluster/connect?${query}`);
          if (run !== runRef.current) return;
          if (data.connected) break;
          if (!ok && httpStatus !== 202) throw new Error(data.error || 'تعذر بدء الربط.');
          if (data.qr) { setQr(data.qr); setWaitNote('امسح الرمز من WhatsApp ← الأجهزة المرتبطة. يتجدد تلقائياً.'); }
          if (data.pairingCode) { setPairingCode(data.pairingCode); codeShown = true; setWaitNote('أدخل الرمز في WhatsApp خلال دقيقتين.'); }
          if (data.pending) {
            setWaitNote(data.status === 'WAKING'
              ? 'الخادم كان نائماً ويستيقظ الآن؛ قد يستغرق ذلك حتى دقيقة.'
              : 'جارٍ تجهيز الجلسة…');
          }
        }
        const current = await refreshStatus();
        if (run !== runRef.current) return;
        if (current?.connected) break;
        await sleep(POLL_MS);
      }
      if (run !== runRef.current) return;
      const final = await refreshStatus();
      if (!final?.connected) setError('انتهت مهلة الربط. اضغط «ابدأ الربط» مرة أخرى.');
    } catch (loopError) {
      if (run === runRef.current) setError(loopError.message || 'تعذر الربط.');
    } finally {
      if (run === runRef.current) {
        setWaiting(false);
        setQr(null);
        setWaitNote('');
      }
    }
  }

  function startLink(event) {
    event?.preventDefault();
    if (method === 'pairing') {
      const digits = phoneNumber.replace(/\D/g, '');
      if (digits.length < 9 || digits.length > 15 || digits.startsWith('0')) {
        setError('اكتب الرقم مع رمز الدولة بدون + أو صفر في البداية، مثل 9665xxxxxxxx.');
        return;
      }
    }
    void waitForLink(method === 'qr' ? 'qr' : 'pairing');
  }

  function cancelLink() {
    runRef.current += 1;
    setWaiting(false);
    setQr(null);
    setPairingCode(null);
    setWaitNote('');
  }

  async function disconnect() {
    if (!window.confirm('سيُسجَّل خروج WhatsApp من خادم Smart.z وتُمسح الجلسة. هل تريد المتابعة؟')) return;
    cancelLink();
    setBusy(true);
    setError('');
    try {
      const { ok, data } = await api('/api/whatsapp/cluster/disconnect', { method: 'POST' });
      if (!ok) throw new Error(data.error || 'تعذر فك الربط.');
      setStatus({ status: 'DISCONNECTED', connected: false, assigned: false, autoReply: false });
    } catch (disconnectError) {
      setError(disconnectError.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleAutoReply() {
    setBusy(true);
    setError('');
    try {
      const { ok, data } = await api('/api/whatsapp/cluster/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoReply: !status.autoReply }),
      });
      if (!ok) throw new Error(data.error || 'تعذر حفظ الإعداد.');
      setStatus((current) => ({ ...current, autoReply: data.autoReply }));
    } catch (toggleError) {
      setError(toggleError.message);
    } finally {
      setBusy(false);
    }
  }

  function copyCode() {
    if (!pairingCode) return;
    navigator.clipboard?.writeText(pairingCode.replace('-', '')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  if (!eligible) {
    return (
      <div className="rounded-lg border border-base-border bg-base-card p-4 text-center text-xs text-text-secondary">
        سجّل الدخول بحساب مفعّل لربط WhatsApp.
      </div>
    );
  }

  const tab = (value, label, current, set) => (
    <button
      type="button"
      onClick={() => set(value)}
      aria-pressed={current === value}
      className={`min-h-9 flex-1 rounded-md px-3 text-xs ${current === value ? 'bg-gold text-base-bg font-semibold' : 'text-text-secondary hover:text-text-primary'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4 rounded-xl border border-base-border bg-base-card p-4">
      <div className="flex gap-1 rounded-lg border border-base-border bg-base-panel p-1">
        {tab('personal', 'حساب شخصي', path, setPath)}
        {tab('business', 'حساب أعمال (Meta)', path, setPath)}
      </div>

      {path === 'business' ? (
        <div className="space-y-3 text-xs leading-6 text-text-secondary">
          <p>للأنشطة التجارية ذات الرسائل الكثيرة: ربط رسمي عبر WhatsApp Business Platform من Meta، برقم أعمال مسجل.</p>
          {metaConnection ? (
            <p className="text-text-primary">
              مرتبط{metaConnection.displayPhoneNumber ? ` · ${metaConnection.displayPhoneNumber}` : ''}
              {metaConnection.verifiedName ? ` · ${metaConnection.verifiedName}` : ''}
            </p>
          ) : null}
          <button type="button" disabled={metaBusy} onClick={onStartMeta}
            className="min-h-10 w-full rounded-lg bg-gold px-3 text-sm font-semibold text-base-bg disabled:opacity-60">
            {metaBusy ? 'جارٍ الربط عبر Meta…' : metaConnection ? 'استبدال رقم الأعمال' : 'ربط حساب الأعمال عبر Meta'}
          </button>
          {metaError && <p role="alert" className="text-amber-300">{metaError}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-secondary">لمن يتلقى رسائل قليلة يومياً. يربط رقمك كجهاز مرتبط.</span>
            <span className={`rounded-full border px-2 py-0.5 ${status.connected ? 'border-emerald-500/40 text-emerald-300' : 'border-base-border text-text-secondary'}`}>
              {STATUS_TEXT[status.status] || status.status}
            </span>
          </div>

          {status.connected ? (
            <div className="space-y-3">
              <p className="text-sm text-text-primary">
                WhatsApp مرتبط{status.phone ? ` بالرقم ${status.phone}` : ''}.
              </p>
              <label className="flex items-center justify-between gap-3 rounded-lg border border-base-border p-3">
                <span className="text-xs leading-5 text-text-secondary">
                  <span className="block text-sm text-text-primary">الرد التلقائي</span>
                  عند التفعيل يرد المساعد على كل رسالة نصية فردية تصلك (لا المجموعات).
                </span>
                <button type="button" role="switch" aria-checked={status.autoReply} disabled={busy} onClick={toggleAutoReply}
                  className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${status.autoReply ? 'bg-gold' : 'bg-base-border'}`}>
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${status.autoReply ? 'right-0.5' : 'right-[22px]'}`} />
                </button>
              </label>
              <button type="button" disabled={busy} onClick={disconnect}
                className="min-h-10 w-full rounded-lg border border-red-500/40 px-3 text-sm text-red-300 disabled:opacity-60">
                فك الربط ومسح الجلسة
              </button>
            </div>
          ) : (
            <form onSubmit={startLink} className="space-y-3">
              <div className="flex gap-1 rounded-lg border border-base-border bg-base-panel p-1">
                {tab('pairing', 'من الهاتف (رمز)', method, setMethod)}
                {tab('qr', 'من الكمبيوتر (QR)', method, setMethod)}
              </div>

              {method === 'pairing' && !pairingCode && (
                <label className="block space-y-1.5">
                  <span className="text-xs text-text-secondary">رقم WhatsApp مع رمز الدولة</span>
                  <input type="tel" inputMode="numeric" dir="ltr" value={phoneNumber} disabled={waiting}
                    onChange={(event) => setPhoneNumber(event.target.value)} placeholder="9665xxxxxxxx"
                    className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-left text-sm text-text-primary" />
                </label>
              )}

              {pairingCode && (
                <div className="space-y-3 rounded-lg border border-gold/40 bg-gold/5 p-3 text-center">
                  <p className="font-mono text-2xl tracking-[0.3em] text-gold" dir="ltr">{pairingCode}</p>
                  <button type="button" onClick={copyCode} className="text-xs text-text-secondary underline">
                    {copied ? 'تم النسخ' : 'نسخ الرمز'}
                  </button>
                  <ol className="list-decimal space-y-1 pr-5 text-right text-xs leading-6 text-text-secondary">
                    <li>افتح WhatsApp ← الإعدادات ← الأجهزة المرتبطة.</li>
                    <li>اضغط «ربط جهاز» ثم «الربط برقم الهاتف بدلاً من ذلك».</li>
                    <li>اكتب الرمز أعلاه. ستتحول الحالة هنا إلى «متصل» تلقائياً.</li>
                  </ol>
                </div>
              )}

              {qr && (
                <div className="space-y-2 text-center">
                  <img src={qr} alt="رمز QR لربط WhatsApp" className="mx-auto h-56 w-56 rounded-lg bg-white p-2" />
                </div>
              )}

              {waiting && waitNote && <p role="status" className="text-xs leading-6 text-text-secondary">{waitNote}</p>}

              {waiting ? (
                <button type="button" onClick={cancelLink}
                  className="min-h-10 w-full rounded-lg border border-base-border px-3 text-sm text-text-primary">
                  إلغاء
                </button>
              ) : (
                <button type="submit" className="min-h-10 w-full rounded-lg bg-gold px-3 text-sm font-semibold text-base-bg">
                  ابدأ الربط
                </button>
              )}
              {status.assigned && !waiting && (
                <button type="button" disabled={busy} onClick={disconnect}
                  className="w-full text-center text-xs text-text-secondary underline-offset-4 hover:underline">
                  تحرير الخادم المحجوز
                </button>
              )}
            </form>
          )}
          {error && <p role="alert" className="text-xs leading-5 text-amber-300">{error}</p>}
        </div>
      )}
    </div>
  );
}
