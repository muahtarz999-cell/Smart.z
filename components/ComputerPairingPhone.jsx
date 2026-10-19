'use client';

import { useEffect, useRef, useState } from 'react';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { installDeviceHeader } from '../lib/device-lock';
import { parseComputerPairingQr } from '../lib/computer-pairing-client';

export default function ComputerPairingPhone() {
  const [accessToken, setAccessToken] = useState('');
  const [authReady, setAuthReady] = useState(false);
  const [scannerActive, setScannerActive] = useState(false);
  const [manualValue, setManualValue] = useState('');
  const [pairing, setPairing] = useState(null);
  const [replacementLabel, setReplacementLabel] = useState('');
  const [tasks, setTasks] = useState([]);
  const [activeDevice, setActiveDevice] = useState(null);
  const [authorizedRoot, setAuthorizedRoot] = useState('');
  const [taskType, setTaskType] = useState('list_files');
  const [taskPath, setTaskPath] = useState('');
  const [taskQuery, setTaskQuery] = useState('');
  const [taskBusy, setTaskBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const videoRef = useRef(null);
  const scannerControlsRef = useRef(null);
  const decodedRef = useRef(false);

  useEffect(() => {
    installDeviceHeader(window);
    if (!isSupabaseConfigured || !supabase) {
      setAuthReady(true);
      return undefined;
    }

    let active = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setAccessToken(session?.access_token || '');
      setAuthReady(true);
    });
    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      setAccessToken(data.session?.access_token || '');
      if (sessionError) setError('تعذر استعادة جلسة تسجيل الدخول.');
      setAuthReady(true);
    }).catch(() => {
      if (!active) return;
      setError('تعذر استعادة جلسة تسجيل الدخول.');
      setAuthReady(true);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => () => scannerControlsRef.current?.stop(), []);

  useEffect(() => {
    if (!accessToken) {
      setTasks([]);
      return undefined;
    }

    let active = true;
    const refreshTasks = async () => {
      try {
        const [tasksResponse, devicesResponse] = await Promise.all([
          fetch('/api/computer/tasks', {
            headers: { Authorization: `Bearer ${accessToken}` },
            cache: 'no-store',
          }),
          fetch('/api/computer/devices', {
            headers: { Authorization: `Bearer ${accessToken}` },
            cache: 'no-store',
          }),
        ]);
        if (!tasksResponse.ok || !devicesResponse.ok) return;
        const [result, deviceResult] = await Promise.all([
          tasksResponse.json(),
          devicesResponse.json(),
        ]);
        if (active && Array.isArray(result.tasks)) setTasks(result.tasks);
        if (active) {
          setActiveDevice(
            Array.isArray(deviceResult.devices)
              ? deviceResult.devices.find((device) => device.status === 'active') || null
              : null,
          );
        }
      } catch {
        if (active) setError('تعذر تحديث حالة مهام الكمبيوتر.');
      }
    };
    void refreshTasks();
    const timer = window.setInterval(refreshTasks, 4000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [accessToken]);

  async function cancelTask(taskId) {
    if (!accessToken) return;
    try {
      const response = await fetch(`/api/computer/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'تعذر إلغاء المهمة.');
      setTasks((current) => current.map((task) =>
        task.id === taskId ? { ...task, status: 'cancelled' } : task
      ));
    } catch (cancelError) {
      setError(cancelError?.message || 'تعذر إلغاء المهمة.');
    }

    async function createTask(event) {
      event.preventDefault();
      if (!accessToken || !activeDevice || taskBusy) return;
      setTaskBusy(true);
      setError('');
      try {
        const payload = {
          authorizedRoot: authorizedRoot.trim(),
          ...(taskType === 'list_files' ? { path: taskPath.trim() } : {}),
          ...(taskType === 'file_metadata' ? { path: taskPath.trim() } : {}),
          ...(taskType === 'search_files' ? { path: taskPath.trim(), query: taskQuery.trim() } : {}),
        };
        const response = await fetch('/api/computer/tasks', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            deviceId: activeDevice.id,
            taskType,
            payload,
          }),
          cache: 'no-store',
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || 'تعذر إنشاء طلب المهمة.');
        const approvalResponse = await fetch(`/api/computer/tasks/${result.task.id}/approval`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ decision: 'approved' }),
          cache: 'no-store',
        });
        const approvalResult = await approvalResponse.json();
        if (!approvalResponse.ok) {
          throw new Error(approvalResult.message || 'أُنشئ الطلب لكن تعذر اعتماده.');
        }
        setTasks((current) => [approvalResult.task, ...current.filter((task) => task.id !== approvalResult.task.id)]);
        setStatus('اعتُمدت المهمة؛ سيبدأ الكمبيوتر تنفيذها إذا كان التطبيق يعمل.');
      } catch (createError) {
        setError(createError?.message || 'تعذر إنشاء المهمة.');
      } finally {
        setTaskBusy(false);
      }
    }
  }

  async function stopScanner() {
    scannerControlsRef.current?.stop();
    scannerControlsRef.current = null;
    setScannerActive(false);
  }

  async function startScanner() {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('الكاميرا تحتاج إلى موقع HTTPS ومتصفح يدعم الوصول إلى الكاميرا.');
      return;
    }

    try {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      const reader = new BrowserQRCodeReader();
      decodedRef.current = false;
      setScannerActive(true);
      const controls = await reader.decodeFromVideoDevice(
        undefined,
        videoRef.current,
        (result) => {
          if (!result || decodedRef.current) return;
          decodedRef.current = true;
          const value = result.getText();
          void stopScanner();
          void loadPairing(value);
        },
      );
      if (decodedRef.current) controls.stop();
      else scannerControlsRef.current = controls;
    } catch {
      setScannerActive(false);
      setError('تعذر تشغيل الكاميرا. تحقق من الإذن أو أدخل بيانات QR يدويًا.');
    }
  }

  async function loadPairing(value) {
    setError('');
    setStatus('');
    try {
      const decoded = parseComputerPairingQr(value, window.location.origin);
      const response = await fetch(`/api/computer/pairing/sessions/${decoded.sessionId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: decoded.token }),
        cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'رمز الاقتران غير صالح أو منتهي.');
      if (result.status !== 'pending' && result.status !== 'approved') {
        throw new Error(result.status === 'expired' ? 'انتهت صلاحية جلسة الاقتران.' : 'اتُخذ قرار سابق بشأن هذه الجلسة.');
      }
      setPairing({ ...decoded, label: result.label });
      setStatus(result.status === 'approved' ? 'سبق أن وافقت على الجلسة؛ يمكنك تأكيد الاستبدال إذا ظهر ذلك.' : '');
    } catch (loadError) {
      setError(loadError?.message || 'تعذر قراءة رمز الاقتران.');
    }
  }

  async function submitDecision(action, replaceExisting = false) {
    if (!pairing || !accessToken) return;
    setError('');
    setStatus('جارٍ إرسال القرار بأمان…');
    try {
      const response = await fetch(`/api/computer/pairing/sessions/${pairing.sessionId}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          token: pairing.token,
          action,
          replaceExisting,
        }),
        cache: 'no-store',
      });
      const result = await response.json();
      if (response.status === 409 && result.code === 'REPLACEMENT_CONFIRMATION_REQUIRED') {
        setReplacementLabel(result.activeDeviceLabel || 'الكمبيوتر النشط');
        setStatus('');
        return;
      }
      if (!response.ok) throw new Error(result.message || 'تعذر تسجيل القرار.');
      setReplacementLabel('');
      setStatus(action === 'approve'
        ? 'وافقت على الاقتران. لا يكتمل الربط إلا بعد إثبات الكمبيوتر امتلاك مفتاحه الخاص.'
        : 'رُفض طلب الاقتران.');
      setPairing(null);
      setManualValue('');
    } catch (decisionError) {
      setStatus('');
      setError(decisionError?.message || 'تعذر تسجيل القرار.');
    }
  }

  return (
    <main className="min-h-dvh bg-base-bg px-4 py-8 text-text-primary">
      <section className="mx-auto max-w-xl rounded-2xl border border-base-border bg-base-panel p-5">
        <a href="/" className="text-sm text-gold hover:underline">العودة إلى Smart.z</a>
        <h1 className="mt-5 text-2xl font-semibold">ربط كمبيوتر</h1>
        <p className="mt-3 text-sm leading-7 text-text-secondary">
          امسح الرمز الظاهر على الكمبيوتر. لن يتم الاقتران قبل موافقتك الصريحة.
          إذا كان هناك كمبيوتر نشط، سيطلب التطبيق تأكيد استبداله بشكل منفصل.
        </p>

        {!authReady ? <p className="mt-5 text-sm text-text-secondary">جارٍ التحقق من تسجيل الدخول…</p> : null}
        {authReady && !accessToken ? (
          <div className="mt-5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm leading-6">
            <p>سجّل الدخول إلى حساب Smart.z المصرّح له بربط الكمبيوتر أولًا.</p>
            <a href="/" className="mt-2 inline-block text-gold underline">تسجيل الدخول</a>
          </div>
        ) : null}

        {authReady && accessToken && !pairing ? (
          <div className="mt-6 space-y-4">
            <button
              type="button"
              onClick={startScanner}
              disabled={scannerActive}
              className="min-h-12 w-full rounded-lg bg-gold px-4 font-semibold text-base-bg disabled:opacity-60"
            >
              {scannerActive ? 'وجّه الكاميرا إلى رمز QR…' : 'مسح رمز QR بالكاميرا'}
            </button>
            <video
              ref={videoRef}
              className={scannerActive ? 'aspect-video w-full rounded-lg bg-black object-cover' : 'hidden'}
              muted
              playsInline
            />
            <label className="block text-sm text-text-secondary">
              بديل: الصق محتوى QR
              <textarea
                value={manualValue}
                onChange={(event) => setManualValue(event.target.value)}
                rows={3}
                className="mt-2 w-full rounded-lg border border-base-border bg-base-bg p-3 text-xs text-text-primary"
                dir="ltr"
              />
            </label>
            <button
              type="button"
              onClick={() => void loadPairing(manualValue)}
              disabled={!manualValue.trim()}
              className="min-h-11 rounded-lg border border-base-border px-4 text-sm disabled:opacity-50"
            >
              التحقق من الرمز
            </button>
          </div>
        ) : null}

        {authReady && accessToken ? (
          <section className="mt-8 border-t border-base-border pt-5">
            <h2 className="text-lg font-semibold">مهام الكمبيوتر</h2>
            {activeDevice ? (
              <form onSubmit={createTask} className="mt-4 space-y-3 rounded-lg border border-base-border p-3">
                <p className="text-xs text-text-secondary">الجهاز النشط: {activeDevice.label}</p>
                <label className="block text-sm">
                  مجلد Windows الذي اخترته وسمحت به في التطبيق
                  <input
                    value={authorizedRoot}
                    onChange={(event) => setAuthorizedRoot(event.target.value)}
                    maxLength={512}
                    required
                    placeholder="C:\Users\Name\Documents"
                    className="mt-1 min-h-10 w-full rounded border border-base-border bg-base-bg px-3 font-mono text-xs"
                  />
                </label>
                <label className="block text-sm">
                  العملية
                  <select
                    value={taskType}
                    onChange={(event) => setTaskType(event.target.value)}
                    className="mt-1 min-h-10 w-full rounded border border-base-border bg-base-bg px-3"
                  >
                    <option value="list_files">عرض الملفات والمجلدات</option>
                    <option value="search_files">البحث عن أسماء الملفات</option>
                    <option value="file_metadata">معلومات ملف</option>
                  </select>
                </label>
                {taskType !== 'search_files' ? (
                  <label className="block text-sm">
                    المسار النسبي داخل المجلد (اختياري للقائمة)
                    <input
                      value={taskPath}
                      onChange={(event) => setTaskPath(event.target.value)}
                      maxLength={512}
                      className="mt-1 min-h-10 w-full rounded border border-base-border bg-base-bg px-3 font-mono text-xs"
                    />
                  </label>
                ) : (
                  <>
                    <label className="block text-sm">
                      البحث عن اسم
                      <input
                        value={taskQuery}
                        onChange={(event) => setTaskQuery(event.target.value)}
                        maxLength={256}
                        required
                        className="mt-1 min-h-10 w-full rounded border border-base-border bg-base-bg px-3"
                      />
                    </label>
                    <label className="block text-sm">
                      المجلد النسبي للبحث (اختياري)
                      <input
                        value={taskPath}
                        onChange={(event) => setTaskPath(event.target.value)}
                        maxLength={512}
                        className="mt-1 min-h-10 w-full rounded border border-base-border bg-base-bg px-3 font-mono text-xs"
                      />
                    </label>
                  </>
                )}
                <button
                  type="submit"
                  disabled={taskBusy}
                  className="min-h-10 rounded bg-gold px-4 text-sm font-semibold text-base-bg disabled:opacity-60"
                >
                  {taskBusy ? 'جارٍ إرسال الطلب واعتماده…' : 'طلب المهمة واعتمادها'}
                </button>
              </form>
            ) : (
              <p className="mt-3 text-sm text-text-secondary">اربط كمبيوتر نشطًا أولًا لطلب المهام.</p>
            )}
            <ul className="mt-3 space-y-3">
              {tasks.map((task) => (
                <li key={task.id} className="rounded-lg border border-base-border p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span>{task.task_type}</span>
                    <span className="text-text-secondary">{task.status}</span>
                  </div>
                  {task.result ? (
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs text-text-secondary">
                      {JSON.stringify(task.result, null, 2)}
                    </pre>
                  ) : null}
                  {['queued', 'awaiting_approval', 'approved', 'running'].includes(task.status) ? (
                    <button
                      type="button"
                      onClick={() => void cancelTask(task.id)}
                      className="mt-2 min-h-9 rounded border border-red-500/50 px-3 text-xs text-red-300"
                    >
                      إلغاء المهمة
                    </button>
                  ) : null}
                </li>
              ))}
              {tasks.length === 0 ? <li className="text-sm text-text-secondary">لا توجد مهام كمبيوتر.</li> : null}
            </ul>
          </section>
        ) : null}

        {pairing ? (
          <div className="mt-6 space-y-4 rounded-xl border border-base-border bg-base-card p-4">
            <p className="text-sm text-text-secondary">الكمبيوتر الذي يطلب الربط:</p>
            <p className="text-lg font-semibold">{pairing.label}</p>
            <p className="text-xs leading-5 text-text-secondary">
              بالموافقة، تسمح لهذا المفتاح العام بالارتباط بحسابك. لا يتم تنفيذ ملفات أو أوامر نظام في هذه المرحلة.
            </p>
            {replacementLabel ? (
              <div role="alert" className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <p className="text-sm leading-6">
                  يوجد كمبيوتر نشط باسم «{replacementLabel}». استبداله سيوقف ارتباطه ويلغي مهامه غير المكتملة.
                </p>
                <button
                  type="button"
                  onClick={() => void submitDecision('approve', true)}
                  className="min-h-11 w-full rounded-lg bg-amber-500 px-4 text-sm font-semibold text-black"
                >
                  أؤكد استبدال الكمبيوتر النشط
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => void submitDecision('approve')}
                  className="min-h-12 rounded-lg bg-gold px-3 text-sm font-semibold text-base-bg"
                >
                  موافقة على الاقتران
                </button>
                <button
                  type="button"
                  onClick={() => void submitDecision('reject')}
                  className="min-h-12 rounded-lg border border-base-border px-3 text-sm text-text-secondary"
                >
                  رفض
                </button>
              </div>
            )}
          </div>
        ) : null}

        {status ? <p role="status" className="mt-4 text-sm leading-6 text-text-secondary">{status}</p> : null}
        {error ? <p role="alert" className="mt-4 text-sm leading-6 text-amber-300">{error}</p> : null}
        <p className="mt-8 border-t border-base-border pt-4 text-xs leading-6 text-text-secondary">
          تأكد أن اسم الكمبيوتر المعروض يطابق الجهاز القريب منك. رموز الاقتران صالحة لخمس دقائق فقط.
        </p>
      </section>
    </main>
  );
}
