'use client';

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
export default function DrivingScreen({ phase, levelRef, transcript, reply, error, onInterrupt, onStop }) {
  const view = PHASES[phase] || PHASES.idle;
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
        {view.hint && <p className="mt-2 text-base text-text-secondary">{view.hint}</p>}
      </div>

      <div className="mt-6 min-w-0">
        <VoiceWave state={waveState} levelRef={levelRef} height={110} />
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        {transcript && <p className="text-center text-base leading-7 text-text-secondary" dir="auto">«{transcript}»</p>}
        {reply && <p className="mt-3 text-center text-2xl leading-10 text-text-primary" dir="auto">{reply}</p>}
        {error && <p role="status" className="mt-3 text-center text-sm leading-6 text-amber-300">{error}</p>}
      </div>

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
