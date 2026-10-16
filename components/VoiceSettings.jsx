'use client';

/**
 * Cloud voice first; the device voice is an optional fallback.
 * Shows only the cloud providers configured on the server.
 */

import { useEffect, useState } from 'react';
import { getVoiceSettings, listCloudProviders, primeSpeech, saveVoiceSettings, testVoice } from '../lib/speech';

const ENGINE_TEXT = { cloud: 'صوت سحابي', device: 'صوت الجهاز' };

export default function VoiceSettings({ onOpenDeviceDiagnostics }) {
  const [settings, setSettings] = useState(() => getVoiceSettings());
  const [providers, setProviders] = useState(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState('');

  useEffect(() => {
    listCloudProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

  function update(changes) {
    setSettings(saveVoiceSettings(changes));
    setResult('');
  }

  const selected = settings.provider === 'auto' ? providers?.at(0) : providers?.find((p) => p.id === settings.provider);
  const selectedVoice = selected ? (settings.voices[selected.id] || selected.defaultVoice) : null;

  function runTest() {
    primeSpeech(); // inside the tap, for iOS
    setTesting(true);
    setResult('');
    testVoice('مرحباً، أنا مساعدك سمارت زد. كيف أقدر أخدمك اليوم؟').then((outcome) => {
      if (outcome.success) {
        const provider = providers?.find((p) => p.id === outcome.provider);
        setResult(`تم التشغيل عبر ${ENGINE_TEXT[outcome.engine] || 'محرك غير معروف'}${provider ? ` (${provider.label})` : ''}.`
          + (outcome.engine === 'device' && outcome.cloudError ? ` تعذر السحابي: ${outcome.cloudError}` : ''));
      } else {
        setResult(`لم يُشغَّل الصوت: ${outcome.error}`);
      }
      setTesting(false);
    });
  }

  return (
    <div className="space-y-4 rounded-lg border border-base-border bg-base-card p-3">
      <div>
        <h3 className="text-sm font-medium text-text-primary">الصوت السحابي (المفضّل)</h3>
        <p className="mt-1 text-xs leading-5 text-text-secondary">
          صوت طبيعي من خدمة سحابية. يُرسل نص الرد إلى الخدمة المختارة لتحويله إلى صوت، ولا تحفظه Smart.z.
        </p>
      </div>

      {providers === null ? (
        <p className="text-xs text-text-secondary">جارٍ تحميل الخدمات المتاحة…</p>
      ) : providers.length === 0 ? (
        <p className="text-xs leading-5 text-amber-300">لا توجد خدمة صوت سحابية مضبوطة على الخادم بعد؛ يُستخدم صوت الجهاز.</p>
      ) : (
        <>
          <label className="block space-y-1.5">
            <span className="text-xs text-text-secondary">الخدمة</span>
            <select value={settings.provider} onChange={(event) => update({ provider: event.target.value })}
              className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-sm text-text-primary">
              <option value="auto">تلقائي (الأفضل المتاح، وينتقل لغيره عند التعذر)</option>
              {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
            </select>
          </label>

          {selected && (
            <label className="block space-y-1.5">
              <span className="text-xs text-text-secondary">الصوت — {selected.label}</span>
              <select value={selectedVoice} onChange={(event) => update({ voices: { ...settings.voices, [selected.id]: event.target.value } })}
                className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-sm text-text-primary">
                {selected.voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>{voice.label} · {voice.gender === 'male' ? 'رجالي' : 'نسائي'}</option>
                ))}
              </select>
            </label>
          )}
        </>
      )}

      <label className="flex items-start justify-between gap-3 border-t border-base-border pt-3">
        <span className="text-xs leading-5 text-text-secondary">
          <span className="block text-sm text-text-primary">صوت الجهاز عند تعذر السحابي</span>
          يعمل دون إنترنت لكنه أقل طبيعية. عند إيقافه يظهر الرد نصاً فقط إذا تعذر الصوت السحابي.
        </span>
        <button type="button" role="switch" aria-checked={settings.deviceFallback}
          onClick={() => update({ deviceFallback: !settings.deviceFallback })}
          className={`relative mt-1 h-6 w-11 flex-shrink-0 rounded-full transition-colors ${settings.deviceFallback ? 'bg-gold' : 'bg-base-border'}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${settings.deviceFallback ? 'right-0.5' : 'right-[22px]'}`} />
        </button>
      </label>

      <button type="button" disabled={testing} onClick={runTest}
        className="min-h-10 w-full rounded-lg border border-gold/50 bg-gold/10 px-3 text-sm text-gold disabled:opacity-60">
        {testing ? 'جارٍ التشغيل…' : 'استمع إلى الصوت الحالي'}
      </button>
      {result && <p role="status" className="text-xs leading-5 text-text-secondary">{result}</p>}
      {onOpenDeviceDiagnostics && settings.deviceFallback && (
        <button type="button" onClick={onOpenDeviceDiagnostics} className="text-xs text-text-secondary underline-offset-4 hover:underline">
          إعدادات صوت الجهاز وتشخيصه
        </button>
      )}
    </div>
  );
}
