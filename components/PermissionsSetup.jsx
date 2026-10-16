'use client';

/**
 * First-run setup. Android and iOS never grant permissions at install time;
 * an app has to ask from inside, in context. This screen asks for each
 * permission the assistant needs and proves the voice actually plays before
 * the user starts talking to it.
 *
 * Required: microphone + a voice the user confirms they heard.
 * Optional: notifications (task reminders, native app only), the driving-mode
 * bubble over other apps (Android app only), learning.
 */

import { useEffect, useState } from 'react';
import { getMicrophonePermissionState, requestMicrophonePermission } from '../lib/voice-recorder';
import { canOpenSpeechEngineSettings, openSpeechEngineSettings } from '../lib/tts';
import { primeSpeech, testVoice as runVoiceTest } from '../lib/speech';
import { areTaskRemindersSupported, requestTaskReminderPermission } from '../lib/task-notifications';
import { setLearningConsent } from '../lib/learning';
import { getOverlayPermission, isNativeDrivingAvailable, requestOverlayPermission } from '../lib/driving-mode';

export const SETUP_STORAGE_KEY = 'smartz-setup-v1';

export function readSetupState() {
  try {
    return JSON.parse(localStorage.getItem(SETUP_STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveSetupState(state) {
  try {
    localStorage.setItem(SETUP_STORAGE_KEY, JSON.stringify({ ...state, savedAt: Date.now() }));
  } catch {
    // Private mode: the screen will simply show again next time.
  }
}

function isIOS() {
  return typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
}

function StepCard({ number, title, status, children }) {
  const badge = {
    done: { text: 'تم', className: 'border-emerald-400/40 text-emerald-300' },
    failed: { text: 'يحتاج إجراء', className: 'border-amber-400/40 text-amber-300' },
    pending: { text: 'مطلوب', className: 'border-base-border text-text-secondary' },
    optional: { text: 'اختياري', className: 'border-base-border text-text-secondary' },
  }[status];
  return (
    <section className="rounded-xl border border-base-border bg-base-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-primary">
          <span className="ml-2 text-gold">{number}</span>{title}
        </h3>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${badge.className}`}>{badge.text}</span>
      </div>
      <div className="mt-3 space-y-3 text-xs leading-6 text-text-secondary">{children}</div>
    </section>
  );
}

export default function PermissionsSetup({ onDone, onSkip }) {
  const [mic, setMic] = useState('pending'); // pending | done | failed
  const [micMessage, setMicMessage] = useState('');
  const [voice, setVoice] = useState('pending'); // pending | testing | asking | done | failed
  const [voiceMessage, setVoiceMessage] = useState('');
  const [notifications, setNotifications] = useState(areTaskRemindersSupported() ? 'optional' : 'unsupported');
  const [busy, setBusy] = useState(false);
  const [learning, setLearning] = useState('optional'); // optional | done | declined
  const [overlay, setOverlay] = useState('unsupported'); // unsupported | optional | done

  useEffect(() => {
    if (!isNativeDrivingAvailable()) return undefined;
    const refresh = () => getOverlayPermission().then((state) => setOverlay(state === 'granted' ? 'done' : 'optional'));
    refresh();
    document.addEventListener('visibilitychange', refresh); // back from Android settings
    return () => document.removeEventListener('visibilitychange', refresh);
  }, []);

  useEffect(() => {
    getMicrophonePermissionState().then((state) => {
      if (state === 'granted') setMic('done');
      if (state === 'denied') {
        setMic('failed');
        setMicMessage('الميكروفون مرفوض سابقاً. افتح إعدادات التطبيق ← الأذونات ← الميكروفون واختر «السماح».');
      }
    });
  }, []);

  async function askMicrophone() {
    setBusy(true);
    setMicMessage('');
    try {
      await requestMicrophonePermission();
      setMic('done');
    } catch (error) {
      setMic('failed');
      setMicMessage(error?.message || 'تعذر الحصول على إذن الميكروفون.');
    } finally {
      setBusy(false);
    }
  }

  function handleTestVoice() {
    primeSpeech(); // must run inside this tap for iOS
    setVoice('testing');
    setVoiceMessage('');
    runVoiceTest('مرحباً، أنا مساعدك سمارت زد. إذا سمعتني فاضغط «سمعت الصوت».')
      .then((result) => {
        if (result.success) {
          setVoice('asking');
        } else {
          setVoice('failed');
          setVoiceMessage(result.error || 'لم يكتمل تشغيل الصوت.');
        }
      })
      .catch((error) => {
        setVoice('failed');
        setVoiceMessage(error?.message || 'تعذر اختبار صوت المساعد.');
      });
  }

  async function installArabicVoice() {
    try {
      await openSpeechEngineSettings();
      setVoiceMessage('بعد تثبيت الصوت العربي ارجع هنا واضغط «اختبار الصوت» مرة أخرى.');
    } catch (error) {
      setVoiceMessage(error?.message || 'تعذر فتح إعدادات محرك النطق.');
    }
  }

  async function askNotifications() {
    setBusy(true);
    try {
      const status = await requestTaskReminderPermission();
      setNotifications(status.permission === 'granted' ? 'done' : 'failed');
    } catch {
      setNotifications('failed');
    } finally {
      setBusy(false);
    }
  }

  async function chooseLearning(granted) {
    try {
      await setLearningConsent(granted);
      setLearning(granted ? 'done' : 'declined');
    } catch {
      setLearning('optional');
    }
  }

  const ready = mic === 'done' && voice === 'done';

  function finish() {
    saveSetupState({ mic, voice, notifications, learning });
    onDone?.();
  }

  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto bg-base-bg/95 px-4 py-6 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="تجهيز المساعد">
      <div className="mx-auto w-full max-w-md space-y-4">
        <header className="space-y-1">
          <h2 className="text-lg font-semibold text-text-primary">تجهيز المساعد على هذا الجهاز</h2>
          <p className="text-xs leading-6 text-text-secondary">
            الهاتف لا يمنح الأذونات عند التثبيت؛ نطلبها هنا مرة واحدة. كل بياناتك تبقى على جهازك.
          </p>
        </header>

        <StepCard number="1" title="الميكروفون" status={mic === 'done' ? 'done' : mic === 'failed' ? 'failed' : 'pending'}>
          <p>لسماع طلباتك. يُفتح فقط أثناء التسجيل ويُغلق فور الإرسال.</p>
          {mic !== 'done' && (
            <button type="button" disabled={busy} onClick={askMicrophone}
              className="min-h-10 w-full rounded-lg bg-gold px-3 text-sm font-semibold text-base-bg disabled:opacity-60">
              السماح بالميكروفون
            </button>
          )}
          {micMessage && <p role="alert" className="text-amber-300">{micMessage}</p>}
        </StepCard>

        <StepCard number="2" title="صوت المساعد" status={voice === 'done' ? 'done' : voice === 'failed' ? 'failed' : 'pending'}>
          <p>نتأكد أنك تسمع الرد فعلاً قبل البدء.</p>
          <ul className="list-disc space-y-1 pr-4">
            <li>ارفع صوت <strong className="text-text-primary">الوسائط</strong> وليس صوت الرنين.</li>
            {isIOS() && <li>افصل وضع الصامت في iPhone (الزر الجانبي)؛ الوضع الصامت يكتم صوت المساعد.</li>}
            <li>افصل سماعة Bluetooth إن لم تكن تستخدمها.</li>
          </ul>
          {voice !== 'asking' && voice !== 'done' && (
            <button type="button" disabled={voice === 'testing'} onClick={handleTestVoice}
              className="min-h-10 w-full rounded-lg border border-gold/50 bg-gold/10 px-3 text-sm text-gold disabled:opacity-60">
              {voice === 'testing' ? 'جارٍ التشغيل…' : 'اختبار الصوت'}
            </button>
          )}
          {voice === 'asking' && (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setVoice('done')}
                className="min-h-10 rounded-lg bg-gold px-3 text-sm font-semibold text-base-bg">سمعت الصوت</button>
              <button type="button" onClick={() => { setVoice('failed'); setVoiceMessage('اتبع النقاط أعلاه ثم أعد الاختبار.'); }}
                className="min-h-10 rounded-lg border border-base-border px-3 text-sm text-text-primary">لم أسمع شيئاً</button>
            </div>
          )}
          {voice === 'failed' && canOpenSpeechEngineSettings() && (
            <button type="button" onClick={installArabicVoice}
              className="min-h-10 w-full rounded-lg border border-base-border px-3 text-sm text-text-primary">
              تثبيت الصوت العربي في Android
            </button>
          )}
          {voiceMessage && <p role="alert" className="text-amber-300">{voiceMessage}</p>}
        </StepCard>

        {notifications !== 'unsupported' && (
          <StepCard number="3" title="الإشعارات" status={notifications === 'done' ? 'done' : 'optional'}>
            <p>لتذكيرك بمواعيد مهامك حتى والتطبيق مغلق.</p>
            {notifications !== 'done' && (
              <button type="button" disabled={busy} onClick={askNotifications}
                className="min-h-10 w-full rounded-lg border border-base-border px-3 text-sm text-text-primary disabled:opacity-60">
                السماح بالإشعارات
              </button>
            )}
            {notifications === 'failed' && <p className="text-amber-300">يمكنك تفعيلها لاحقاً من إعدادات الهاتف.</p>}
          </StepCard>
        )}

        {overlay !== 'unsupported' && (
          <StepCard number={notifications !== 'unsupported' ? '4' : '3'} title="الظهور فوق التطبيقات (وضع القيادة)" status={overlay === 'done' ? 'done' : 'optional'}>
            <p>في وضع القيادة تظهر فقاعة صغيرة فوق الخرائط تبيّن أن المساعد يستمع، وتلمسها لإيقاف كلامه.</p>
            {overlay !== 'done' && (
              <button type="button" onClick={async () => setOverlay((await requestOverlayPermission()) ? 'done' : 'optional')}
                className="min-h-10 w-full rounded-lg border border-base-border px-3 text-sm text-text-primary">
                السماح بالظهور فوق التطبيقات
              </button>
            )}
          </StepCard>
        )}

        <StepCard number={String(3 + (notifications !== 'unsupported' ? 1 : 0) + (overlay !== 'unsupported' ? 1 : 0))} title="التعلّم الشخصي" status={learning === 'done' ? 'done' : 'optional'}>
          <p>
            يتعلّم المساعد اسمك ولهجتك وأسلوبك واهتماماتك ليخدمك بشكل أفضل. ما يتعلّمه يُحفظ على هذا الهاتف فقط،
            ويُرسل ملخصه مع طلباتك إلى مزوّد الذكاء الاصطناعي دون أن تحفظه Smart.z. تراه وتحذفه متى شئت من «التعلم والتخصيص».
          </p>
          {learning === 'optional' ? (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => chooseLearning(true)}
                className="min-h-10 rounded-lg bg-gold px-3 text-sm font-semibold text-base-bg">أوافق</button>
              <button type="button" onClick={() => chooseLearning(false)}
                className="min-h-10 rounded-lg border border-base-border px-3 text-sm text-text-primary">ليس الآن</button>
            </div>
          ) : (
            <p className="text-text-primary">{learning === 'done' ? 'التعلّم مفعّل.' : 'التعلّم متوقف؛ يمكنك تفعيله لاحقاً.'}</p>
          )}
        </StepCard>

        <button type="button" disabled={!ready} onClick={finish}
          className="min-h-11 w-full rounded-lg bg-gold px-3 text-sm font-semibold text-base-bg disabled:opacity-40">
          ابدأ استخدام المساعد
        </button>
        <button type="button" onClick={() => { saveSetupState({ mic, voice, notifications, skipped: true }); onSkip?.(); }}
          className="w-full text-center text-xs text-text-secondary underline-offset-4 hover:underline">
          تخطٍّ الآن (لن يعمل الصوت حتى تكمل الخطوتين)
        </button>
      </div>
    </div>
  );
}
