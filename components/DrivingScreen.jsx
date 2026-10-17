'use client';

import { useEffect, useState } from 'react';
import VoiceWave from './VoiceWave';

const PHASES = {
  listening: { label: 'أستمع…', hint: 'تكلّم متى شئت' },
  thinking: { label: 'أفكر…', hint: '' },
  transcribing: { label: 'أفكر…', hint: '' },
  speaking: { label: 'أتحدث', hint: 'المس الشاشة لإيقافي' },
  paused: { label: 'متوقف مؤقتاً', hint: 'يعود الاستماع حين يكون التطبيق على الشاشة' },
  idle: { label: 'وضع القيادة', hint: '' },
};

/**
 * Full-screen driving view: big status, the vibrating line, the last reply in
 * large type. A tap anywhere stops the assistant talking; only the red button
 * ends driving mode, so a stray touch never does.
 */
const VAD_LABELS = { on: 'يعمل', off: 'أُوقف تلقائيًا', unavailable: 'غير متاح' };

export default function DrivingScreen({ phase, levelRef, transcript, reply, error, onInterrupt, onStop, callByName = false, heard = null, diagnostics = null }) {
  const view = phase === 'listening' && callByName
    ? { label: PHASES.listening.label, hint: 'نادِ «سمارت» قبل سؤالك' }
    : PHASES[phase] || PHASES.idle;
  const waveState = phase === 'speaking' ? 'speaking' : phase === 'listening' ? 'listening' : phase === 'paused' ? 'ready' : 'thinking';

  return (
    <div
      role="dialog"
      aria-label="وضع القيادة"
      onClick={onInterrupt}
      className="fixed inset-0 z-50 flex flex-col bg-base-bg px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))]"
    >
      <div className="flex items-center justify-between text-text-secondary">
        <span className="text-sm">🚗 وضع القيادة</span>
        <span className="text-xs">قل «وضع القيادة انتهى» للإنهاء</span>
      </div>

      <div className="mt-8 text-center">
        <p className="text-4xl font-bold text-text-primary">{view.label}</p>
        {view.hint && <p className={`mt-2 ${callByName && phase === 'listening' ? 'text-xl font-semibold text-gold' : 'text-base text-text-secondary'}`}>{view.hint}</p>}
        {callByName && <p className="mt-1 text-xs text-text-secondary">مثال: «سمارت، اقرأ رسائلي». أحاديث الركاب لا يرد عليها.</p>}
      </div>

      <div className="mt-6 min-w-0">
        <VoiceWave state={waveState} levelRef={levelRef} height={110} />
      </div>

      {/* Heard but not answered: proves the microphone works without speaking over the passengers. */}
      {heard && (
        <p className="mt-3 text-center text-sm leading-6 text-amber-300" dir="auto">
          سمعت: «{heard.transcript}»
          <span className="block text-xs text-text-secondary">
            {heard.reason === 'not_called' ? 'لم أرد لأنك لم تبدأ بـ«سمارت».' : 'بدا ضجيجًا فتجاهلته.'}
          </span>
        </p>
      )}

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        {transcript && <p className="text-center text-base leading-7 text-text-secondary" dir="auto">«{transcript}»</p>}
        {reply && <p className="mt-3 text-center text-2xl leading-10 text-text-primary" dir="auto">{reply}</p>}
        {error && <p role="status" className="mt-3 text-center text-sm leading-6 text-amber-300">{error}</p>}
      </div>

      {/* Sound check: the voice must pass the bar for a sentence to start. */}
      {diagnostics && phase === 'listening' && (
        <SoundCheck levelRef={levelRef} diagnostics={diagnostics} />
      )}

      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); onStop(); }}
        className="mt-4 min-h-16 w-full rounded-full bg-red-500 text-lg font-bold text-white"
      >
        إنهاء وضع القيادة
      </button>
    </div>
  );
}

/** A thin meter: the live level against the bar a sentence must pass, and the voice model's state. */
function SoundCheck({ levelRef, diagnostics }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setLevel(Math.min(1, levelRef?.current || 0)), 150);
    return () => clearInterval(timer);
  }, [levelRef]);
  const bar = Math.min(1, diagnostics.threshold || 0);
  return (
    <div className="mt-3 space-y-1 text-[11px] text-text-secondary" dir="rtl">
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-base-card">
        <div className={`absolute inset-y-0 right-0 rounded-full ${level > bar ? 'bg-emerald-400' : 'bg-text-secondary/60'}`} style={{ width: `${level * 100}%` }} />
        <div className="absolute inset-y-0 w-0.5 bg-gold" style={{ right: `${bar * 100}%` }} />
      </div>
      <p className="flex justify-between">
        <span>صوتك {level > bar ? 'يتجاوز الحد ✓' : 'تحت الحد'}</span>
        <span>مصنّف الصوت: {VAD_LABELS[diagnostics.vad] || VAD_LABELS.unavailable}</span>
      </p>
    </div>
  );
}
