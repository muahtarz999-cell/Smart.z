'use client';

import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  createComputerKeyPair,
  deleteComputerPrivateKey,
  getComputerPrivateKey,
  moveComputerPrivateKey,
  saveComputerPrivateKey,
  signComputerPairingChallenge,
} from '../lib/computer-pairing-client';

const DEFAULT_LABEL = 'Windows computer';
const SESSION_STORAGE_KEY = 'smartz-computer-pairing-session';

export default function ComputerPairingDesktop() {
  const [label, setLabel] = useState(DEFAULT_LABEL);
  const [phase, setPhase] = useState('idle');
  const [session, setSession] = useState(null);
  const [message, setMessage] = useState('');
  const [expiresIn, setExpiresIn] = useState(0);
  const privateKeyRef = useRef(null);
  const busyRef = useRef(false);

  useEffect(() => {
    let active = true;
    async function restorePendingSession() {
      try {
        const serialized = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
        if (!serialized) return;
        const pending = JSON.parse(serialized);
        const expiryTime = Date.parse(pending?.expiresAt);
        if (
          pending?.origin !== window.location.origin ||
          !Number.isFinite(expiryTime) ||
          expiryTime <= Date.now() ||
          typeof pending.sessionId !== 'string' ||
          typeof pending.token !== 'string'
        ) {
          window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
          return;
        }
        const key = await getComputerPrivateKey(pending.sessionId);
        if (!active) return;
        if (!key) {
          window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
          setMessage('لم يُعثر على المفتاح الخاص لهذه الجلسة. ابدأ جلسة اقتران جديدة.');
          return;
        }
        privateKeyRef.current = key;
        setSession(pending);
        setPhase('waiting');
        setMessage('استُعيدت جلسة الاقتران. امسح الرمز من الهاتف أو تابع الانتظار.');
      } catch {
        if (active) setMessage('تعذر استعادة جلسة الاقتران المحفوظة.');
      }
    }
    void restorePendingSession();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!session?.expiresAt || phase !== 'waiting') return undefined;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((Date.parse(session.expiresAt) - Date.now()) / 1000));
      setExpiresIn(remaining);
      if (remaining === 0) {
        setPhase('expired');
        setMessage('انتهت صلاحية رمز الاقتران. ابدأ جلسة جديدة.');
      }
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [session, phase]);

  useEffect(() => {
    if (!session?.sessionId || phase !== 'waiting') return undefined;
    let active = true;
    const poll = async () => {
      if (busyRef.current || !active) return;
      busyRef.current = true;
      try {
        const response = await fetch(`/api/computer/pairing/sessions/${session.sessionId}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: session.token }),
          cache: 'no-store',
        });
        const result = await response.json();
        if (!active) return;
        if (!response.ok) {
          if (response.status === 404 || response.status === 410) {
            setPhase('expired');
            setMessage(result.message || 'انتهت جلسة الاقتران.');
          }
          return;
        }
        if (result.status === 'rejected') {
          setPhase('rejected');
          setMessage('رفض المستخدم هذا الاقتران.');
        } else if (result.status === 'expired') {
          setPhase('expired');
          setMessage('انتهت صلاحية رمز الاقتران.');
        } else if (result.status === 'completed' && result.deviceId) {
          await moveComputerPrivateKey(session.sessionId, result.deviceId);
          if (!active) return;
          window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
          setPhase('complete');
          setMessage('تم الاقتران. حُفظ المفتاح الخاص غير القابل للتصدير في ملف المتصفح.');
        } else if (result.status === 'approved' && result.challenge) {
          const signature = await signComputerPairingChallenge(
            privateKeyRef.current,
            session.sessionId,
            result.challenge,
          );
          const completeResponse = await fetch(`/api/computer/pairing/sessions/${session.sessionId}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: session.token, signature }),
            cache: 'no-store',
          });
          const completeResult = await completeResponse.json();
          if (!active) return;
          if (completeResponse.ok && completeResult.success && completeResult.deviceId) {
            await moveComputerPrivateKey(session.sessionId, completeResult.deviceId);
            window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
            setPhase('complete');
            setMessage('تم الاقتران. حُفظ المفتاح الخاص غير القابل للتصدير في ملف المتصفح.');
          } else if (completeResponse.status === 409 && completeResult.code === 'REPLACEMENT_CONFIRMATION_REQUIRED') {
            setMessage('يوجد كمبيوتر نشط آخر. امسح الرمز نفسه من الهاتف وأكد استبداله؛ ستُعاد المحاولة تلقائيًا.');
          } else if (completeResponse.status === 410) {
            setPhase('expired');
            setMessage(completeResult.message || 'انتهت صلاحية الاقتران.');
          } else {
            setMessage(completeResult.message || 'تعذر إكمال الاقتران؛ ستتم إعادة المحاولة تلقائيًا.');
          }
        }
      } catch {
        if (active) setMessage('تعذر الاتصال بالخدمة؛ ستتم إعادة المحاولة تلقائيًا.');
      } finally {
        busyRef.current = false;
      }
    };

    poll();
    const timer = window.setInterval(poll, 1800);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [session, phase]);

  async function startPairing(event) {
    event.preventDefault();
    if (phase === 'creating') return;
    const cleanLabel = label.trim();
    if (!cleanLabel || cleanLabel.length > 64) {
      setMessage('اكتب اسمًا من 1 إلى 64 حرفًا للجهاز.');
      return;
    }
    setPhase('creating');
    setMessage('');

    try {
      const keyPair = await createComputerKeyPair();
      const response = await fetch('/api/computer/pairing/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: keyPair.publicKey, deviceLabel: cleanLabel }),
        cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'تعذر إنشاء جلسة الاقتران.');

      privateKeyRef.current = keyPair.privateKey;
      await saveComputerPrivateKey(result.sessionId, keyPair.privateKey);
      const nextSession = { ...result, origin: window.location.origin };
      let resumable = true;
      try {
        window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(nextSession));
      } catch {
        resumable = false;
      }
      setSession(nextSession);
      setPhase('waiting');
      setMessage(resumable
        ? 'امسح الرمز من داخل تطبيق Smart.z على الهاتف، ثم وافق صراحةً.'
        : 'امسح الرمز من داخل تطبيق Smart.z على الهاتف، ثم وافق صراحةً. لا تغلق هذه الصفحة قبل اكتمال الاقتران.');
    } catch (error) {
      setPhase('idle');
      setMessage(error?.message || 'المتصفح لا يدعم إنشاء مفتاح اقتران آمن.');
    }
  }

  async function reset() {
    setPhase('cancelling');
    setMessage('جارٍ إلغاء جلسة الاقتران وحذف المفتاح المحلي…');
    try {
      if (session?.sessionId && session?.token) {
        const response = await fetch(`/api/computer/pairing/sessions/${session.sessionId}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: session.token }),
          cache: 'no-store',
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          throw new Error(result.message || 'تعذر إلغاء جلسة الاقتران.');
        }
        await deleteComputerPrivateKey(session.sessionId);
      }
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (error) {
      setPhase('cancelError');
      setMessage(error?.message || 'تعذر إلغاء جلسة الاقتران أو حذف المفتاح المحلي.');
      return;
    }
    setSession(null);
    privateKeyRef.current = null;
    busyRef.current = false;
    setPhase('idle');
    setMessage('');
    setExpiresIn(0);
  }

  const qrValue = session
    ? JSON.stringify({
      version: 1,
      origin: session.origin,
      sessionId: session.sessionId,
      token: session.token,
    })
    : '';

  return (
    <main className="min-h-dvh bg-base-bg px-4 py-10 text-text-primary">
      <section className="mx-auto max-w-xl rounded-2xl border border-base-border bg-base-panel p-6 shadow-xl">
        <a href="/" className="text-sm text-gold hover:underline">Smart.z</a>
        <h1 className="mt-5 text-2xl font-semibold">اقتران كمبيوتر Windows</h1>
        <p className="mt-3 text-sm leading-7 text-text-secondary">
          ينشئ هذا المتصفح مفتاح Ed25519 محليًا. لا يُرفع المفتاح الخاص؛ يُرسل المفتاح العام فقط،
          ويُحفظ المفتاح الخاص غير القابل للتصدير في تخزين المتصفح بعد إنشاء الجلسة.
        </p>
        <p className="mt-2 text-sm">
          <a href="/computer/approve" className="text-gold hover:underline">
            هل أنت على الهاتف؟ افتح الماسح لمسح رمز الكمبيوتر
          </a>
        </p>
        {phase === 'idle' || phase === 'creating' ? (
          <form onSubmit={startPairing} className="mt-6 space-y-4">
            <label className="block text-sm">
              اسم الكمبيوتر
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={64}
                className="mt-2 min-h-12 w-full rounded-lg border border-base-border bg-base-bg px-3 text-text-primary"
                autoComplete="off"
              />
            </label>
            <button
              type="submit"
              disabled={phase === 'creating'}
              className="min-h-12 w-full rounded-lg bg-gold px-4 font-semibold text-base-bg disabled:opacity-60"
            >
              {phase === 'creating' ? 'جارٍ إنشاء جلسة آمنة…' : 'إنشاء رمز اقتران'}
            </button>
          </form>
        ) : null}

        {phase === 'waiting' && qrValue ? (
          <div className="mt-6 flex flex-col items-center gap-4">
            <div className="rounded-xl bg-white p-4">
              <QRCodeSVG value={qrValue} size={256} level="M" />
            </div>
            <p className="text-center text-sm leading-6 text-text-secondary">{message}</p>
            <p aria-live="polite" className="font-mono text-sm text-gold">
              تنتهي الجلسة خلال {Math.floor(expiresIn / 60)}:{String(expiresIn % 60).padStart(2, '0')}
            </p>
            <button type="button" onClick={() => void reset()} className="min-h-11 rounded-lg border border-base-border px-5 text-sm">
              إلغاء الاقتران
            </button>
          </div>
        ) : null}

        {phase !== 'waiting' && phase !== 'idle' && phase !== 'creating' ? (
          <div className="mt-6 space-y-4" role="status">
            <p className="text-sm leading-7 text-text-secondary">{message}</p>
            {phase === 'cancelling' ? <p className="text-sm">{message}</p> : null}
            {phase === 'replacementRequired' || phase === 'expired' || phase === 'rejected' || phase === 'cancelError' ? (
              <button type="button" onClick={() => void reset()} className="min-h-11 rounded-lg bg-gold px-5 text-sm font-semibold text-base-bg">
                بدء اقتران جديد
              </button>
            ) : null}
          </div>
        ) : null}

        {message && (phase === 'idle' || phase === 'creating') ? (
          <p role="status" className="mt-4 text-sm text-amber-300">{message}</p>
        ) : null}

        <p className="mt-8 border-t border-base-border pt-4 text-xs leading-6 text-text-secondary">
          هذا الإجراء يثبت ملكية مفتاح الكمبيوتر فقط. لا يفعّل تنفيذ الملفات أو أوامر النظام.
        </p>
      </section>
    </main>
  );
}
