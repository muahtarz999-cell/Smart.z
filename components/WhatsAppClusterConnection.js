'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export default function WhatsAppClusterConnection({ authSession, customerAccess }) {
  const [activeTab, setActiveTab] = useState('mobile'); // 'mobile' | 'qr'
  const [phoneNumber, setPhoneNumber] = useState('');
  const [status, setStatus] = useState('DISCONNECTED'); // 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR'
  const [assignedNodeId, setAssignedNodeId] = useState(null);
  const [qrCode, setQrCode] = useState(null);
  const [pairingCode, setPairingCode] = useState(null);
  const [deepLink, setDeepLink] = useState(null);
  const [loading, setLoading] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [copied, setCopied] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const pollTimerRef = useRef(null);

  const token = authSession?.access_token;
  const isEligible = customerAccess?.status === 'active' && Boolean(token);

  // Poll connection status
  const fetchStatus = useCallback(async (silent = false) => {
    if (!token) return;
    if (!silent) setCheckingStatus(true);

    try {
      const response = await fetch('/api/whatsapp/cluster/status', {
        headers: {
          Authorization: `Bearer ${token}`,
          'Cache-Control': 'no-store',
        },
      });

      const data = await response.json();
      if (response.ok) {
        setStatus(data.status || 'DISCONNECTED');
        if (data.nodeId) setAssignedNodeId(data.nodeId);
        if (data.status === 'CONNECTED') {
          setQrCode(null);
          setPairingCode(null);
          setDeepLink(null);
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
        }
      }
    } catch (err) {
      if (!silent) {
        console.warn('[WhatsApp Cluster] Status check error:', err);
      }
    } finally {
      if (!silent) setCheckingStatus(false);
    }
  }, [token]);

  // Initial status check
  useEffect(() => {
    if (isEligible) {
      fetchStatus();
    }
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, [isEligible, fetchStatus]);

  // Start polling when waiting for connection
  const startPolling = useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = setInterval(() => {
      fetchStatus(true);
    }, 4000);
  }, [fetchStatus]);

  // Request QR Code
  async function handleRequestQr() {
    if (!token) return;
    setLoading(true);
    setErrorMessage('');
    setPairingCode(null);
    setDeepLink(null);

    try {
      const response = await fetch('/api/whatsapp/cluster/connect?method=qr', {
        headers: {
          Authorization: `Bearer ${token}`,
          'Cache-Control': 'no-store',
        },
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'تعذر استخراج رمز الـ QR.');
      }

      setQrCode(data.qr);
      if (data.nodeId) setAssignedNodeId(data.nodeId);
      if (data.status) setStatus(data.status);

      startPolling();
    } catch (err) {
      setErrorMessage(err.message || 'حدث خطأ أثناء طلب رمز الـ QR.');
    } finally {
      setLoading(false);
    }
  }

  // Request Pairing Code
  async function handleRequestPairingCode(e) {
    if (e) e.preventDefault();
    if (!token) return;

    const cleanedNumber = phoneNumber.replace(/\D/g, '');
    if (!cleanedNumber || cleanedNumber.length < 9) {
      setErrorMessage('يرجى إدخال رقم هاتف صحيح مع كود الدولة (مثال: 9665xxxxxxxx أو 201xxxxxxxxx).');
      return;
    }

    setLoading(true);
    setErrorMessage('');
    setQrCode(null);

    try {
      const response = await fetch(
        `/api/whatsapp/cluster/connect?method=pairing_code&phoneNumber=${encodeURIComponent(cleanedNumber)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Cache-Control': 'no-store',
          },
        }
      );

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'تعذر استخراج رمز الاقتران.');
      }

      setPairingCode(data.pairingCode);
      setDeepLink(data.deepLink);
      if (data.nodeId) setAssignedNodeId(data.nodeId);
      if (data.status) setStatus(data.status);

      startPolling();
    } catch (err) {
      setErrorMessage(err.message || 'حدث خطأ أثناء طلب رمز الاقتران.');
    } finally {
      setLoading(false);
    }
  }

  // Disconnect & release node slot
  async function handleDisconnect() {
    if (!token) return;
    if (!window.confirm('هل أنت متأكد من رغبتك في إلغاء ربط الواتساب وفك حجز الخادم؟')) return;

    setLoading(true);
    setErrorMessage('');
    try {
      const response = await fetch('/api/whatsapp/cluster/disconnect', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        setStatus('DISCONNECTED');
        setAssignedNodeId(null);
        setQrCode(null);
        setPairingCode(null);
        setDeepLink(null);
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      }
    } catch (err) {
      setErrorMessage('تعذر قطع الاتصال حالياً.');
    } finally {
      setLoading(false);
    }
  }

  // Copy pairing code to clipboard
  function handleCopyPairingCode() {
    if (!pairingCode) return;
    navigator.clipboard.writeText(pairingCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  if (!isEligible) {
    return (
      <div className="rounded-lg border border-base-border bg-base-card p-4 text-center">
        <p className="text-xs text-text-secondary">سجّل الدخول بحساب معتمد لتفعيل ربط مساعد الواتساب.</p>
      </div>
    );
  }

  const isConnected = status === 'CONNECTED';

  return (
    <div className="space-y-4 rounded-xl border border-base-border bg-base-card p-4 transition-all">
      {/* Header and Live Status */}
      <div className="flex items-center justify-between border-b border-base-border/60 pb-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">مساعد الواتساب الموزع</h3>
          <p className="mt-0.5 text-xs text-text-secondary">
            عنقود سحابي موزع عبر 5 خوادم Render مع عزل كامل لكل مشترك.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {assignedNodeId && (
            <span className="rounded-full border border-base-border bg-base-panel px-2.5 py-0.5 text-[11px] text-text-secondary font-mono">
              خادم #{assignedNodeId}
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
              isConnected
                ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                : status === 'CONNECTING'
                ? 'border border-amber-500/30 bg-amber-500/10 text-amber-400'
                : 'border border-base-border bg-base-panel text-text-secondary'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isConnected
                  ? 'bg-emerald-400 animate-pulse'
                  : status === 'CONNECTING'
                  ? 'bg-amber-400 animate-ping'
                  : 'bg-text-secondary'
              }`}
            />
            {isConnected ? 'متصل بنجاح' : status === 'CONNECTING' ? 'جارٍ الاتصال...' : 'غير متصل'}
          </span>
        </div>
      </div>

      {/* State: CONNECTED */}
      {isConnected ? (
        <div className="space-y-3 py-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-text-primary">الجلسة نشطة ومحمية</p>
            <p className="mt-1 text-xs text-text-secondary">
              تم تثبيت حسابك على الخادم المخصص #{assignedNodeId}، ومساعدك جاهز لتلقي واستقبال الرسائل.
            </p>
          </div>
          <button
            type="button"
            onClick={handleDisconnect}
            disabled={loading}
            className="mt-2 min-h-9 rounded-lg border border-red-500/30 bg-red-500/10 px-4 text-xs font-medium text-red-400 hover:bg-red-500/20 disabled:opacity-60 transition-colors"
          >
            {loading ? 'جارٍ فك الارتباط...' : 'قطع الاتصال وإلغاء حجز الخادم'}
          </button>
        </div>
      ) : (
        /* State: DISCONNECTED / PAIRING */
        <div className="space-y-4">
          {/* Tab Selector: Mobile vs Desktop */}
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-base-border bg-base-panel p-1">
            <button
              type="button"
              onClick={() => {
                setActiveTab('mobile');
                setErrorMessage('');
              }}
              className={`flex items-center justify-center gap-2 rounded-md py-1.5 text-xs font-medium transition-colors ${
                activeTab === 'mobile'
                  ? 'bg-gold/15 text-gold border border-gold/30 shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              الهاتف المحمول (Pairing Code)
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('qr');
                setErrorMessage('');
              }}
              className={`flex items-center justify-center gap-2 rounded-md py-1.5 text-xs font-medium transition-colors ${
                activeTab === 'qr'
                  ? 'bg-gold/15 text-gold border border-gold/30 shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
              </svg>
              الكمبيوتر (QR Code)
            </button>
          </div>

          {/* Tab 1: Mobile (Pairing Code + Deep Link) */}
          {activeTab === 'mobile' && (
            <div className="space-y-3">
              <form onSubmit={handleRequestPairingCode} className="space-y-2">
                <label htmlFor="cluster-phone" className="block text-xs font-medium text-text-primary">
                  رقم الهاتف (مع مفتاح الدولة)
                </label>
                <div className="flex gap-2">
                  <input
                    id="cluster-phone"
                    type="tel"
                    dir="ltr"
                    placeholder="مثال: 966501234567 أو 201012345678"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    disabled={loading}
                    className="flex-1 rounded-lg border border-base-border bg-base-panel px-3 py-2 text-xs text-text-primary placeholder:text-text-secondary/50 focus:border-gold/50 focus:outline-none focus:ring-1 focus:ring-gold/50"
                  />
                  <button
                    type="submit"
                    disabled={loading || !phoneNumber.trim()}
                    className="min-h-9 rounded-lg border border-gold/40 bg-gold/10 px-4 text-xs font-medium text-gold hover:bg-gold/20 disabled:border-base-border disabled:text-text-secondary disabled:opacity-50 transition-colors"
                  >
                    {loading ? 'جارٍ الطلب...' : 'طلب الرمز'}
                  </button>
                </div>
              </form>

              {/* Pairing Code Display */}
              {pairingCode && (
                <div className="space-y-3 rounded-lg border border-gold/30 bg-gold/5 p-3.5 text-center animate-fade-in">
                  <p className="text-xs text-text-secondary">رمز الاقتران المخصص لحسابك:</p>
                  <div className="my-1 flex items-center justify-center gap-3">
                    <span className="font-mono text-2xl font-bold tracking-widest text-gold select-all">
                      {pairingCode}
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyPairingCode}
                      className="rounded border border-gold/40 bg-gold/10 px-2 py-1 text-[11px] text-gold hover:bg-gold/20 transition-colors"
                      title="نسخ الرمز"
                    >
                      {copied ? 'تم النسخ ✓' : 'نسخ'}
                    </button>
                  </div>

                  {deepLink && (
                    <div className="pt-1">
                      <a
                        href={deepLink}
                        className="inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 transition-colors"
                      >
                        <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 9.27 20.92 6.78 19.05 4.91C17.18 3.03 14.69 2 12.04 2M12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.72 20.28 11.92C20.28 16.46 16.58 20.15 12.04 20.15C10.56 20.15 9.11 19.76 7.85 19.01L7.55 18.83L4.43 19.65L5.26 16.61L5.06 16.29C4.24 14.99 3.8 13.47 3.8 11.91C3.81 7.37 7.5 3.67 12.05 3.67Z" />
                        </svg>
                        فتح في واتساب مباشرة (Deep Link)
                      </a>
                    </div>
                  )}

                  <p className="mt-2 text-[11px] leading-4 text-text-secondary">
                    افتح الرابط أعلاه من هاتفك أو افتح إشعار واتساب، ثم اكتب الرمز للتأكيد.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Tab 2: Desktop (QR Code) */}
          {activeTab === 'qr' && (
            <div className="space-y-3 text-center">
              {qrCode ? (
                <div className="space-y-2">
                  <div className="inline-block rounded-xl border border-base-border bg-white p-3 shadow-md">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={qrCode}
                      alt="رمز الاستجابة السريعة لواتساب"
                      className="h-48 w-48 object-contain"
                    />
                  </div>
                  <p className="text-xs text-text-secondary">
                    امسح الرمز بكاميرا واتساب (الأجهزة المرتبطة) من هاتفك.
                  </p>
                  <button
                    type="button"
                    onClick={handleRequestQr}
                    disabled={loading}
                    className="text-[11px] text-gold hover:underline disabled:opacity-50"
                  >
                    {loading ? 'جارٍ التحديث...' : 'إعادة توليد رمز جديد'}
                  </button>
                </div>
              ) : (
                <div className="py-4">
                  <p className="mb-3 text-xs text-text-secondary">
                    انقر أدناه لتوليد رمز الاستجابة السريعة من خادم الواتساب المخصص لك.
                  </p>
                  <button
                    type="button"
                    onClick={handleRequestQr}
                    disabled={loading}
                    className="min-h-9 rounded-lg border border-gold/40 bg-gold/10 px-5 text-xs font-medium text-gold hover:bg-gold/20 disabled:border-base-border disabled:text-text-secondary disabled:opacity-50 transition-colors"
                  >
                    {loading ? 'جارٍ استخراج الرمز من السيرفر...' : 'عرض رمز الـ QR'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Error Message Display */}
          {errorMessage && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-400">
              {errorMessage}
            </div>
          )}

          {/* Checking Status Indicator */}
          {checkingStatus && (
            <p className="text-center text-[11px] text-text-secondary animate-pulse">
              جارٍ فحص حالة الاتصال لحظياً...
            </p>
          )}
        </div>
      )}
    </div>
  );
}

