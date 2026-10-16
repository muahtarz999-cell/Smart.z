'use client';

/**
 * "What the assistant has learned about you": the user sees every item,
 * removes any of them, triggers learning, or turns learning off.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  clearLearnedProfile,
  getLearningState,
  learnFromRecentConversation,
  saveLearnedProfile,
  setLearningConsent,
} from '../lib/learning';
import { isProfileEmpty } from '../lib/learned-profile';

function formatDate(timestamp) {
  if (!timestamp) return '';
  try {
    return new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
  } catch {
    return '';
  }
}

function Item({ label, value, onRemove }) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-base-border bg-base-panel px-3 py-2">
      <div className="min-w-0 flex-1 text-sm leading-6 text-text-primary">
        {label && <span className="ml-1 text-xs text-text-secondary">{label}:</span>}
        <span className="break-words">{value}</span>
      </div>
      <button type="button" onClick={onRemove} aria-label={`حذف: ${value}`}
        className="shrink-0 rounded-md px-2 py-1 text-xs text-text-secondary hover:text-red-300">حذف</button>
    </li>
  );
}

export default function LearningPanel({ getAccessToken, refreshKey }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const reload = useCallback(async () => {
    try {
      setState(await getLearningState());
    } catch {
      setMessage('تعذر قراءة ملف التعلّم من هذا الجهاز.');
    }
  }, []);

  useEffect(() => { void reload(); }, [reload, refreshKey]);

  if (!state) return <p className="text-sm text-text-secondary">جارٍ التحميل…</p>;

  const { profile } = state;

  async function toggleConsent() {
    setMessage('');
    await setLearningConsent(!state.consent);
    await reload();
  }

  async function update(changes) {
    await saveLearnedProfile({ ...profile, ...changes });
    await reload();
  }

  async function learnNow() {
    setBusy(true);
    setMessage('');
    try {
      const result = await learnFromRecentConversation({ getAccessToken, force: true });
      setMessage(result ? 'تم تحديث ما تعلّمه المساعد.' : 'لا توجد محادثات جديدة للتعلّم منها.');
      await reload();
    } catch (error) {
      setMessage(error?.message || 'تعذر التعلّم الآن.');
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (!window.confirm('سيُحذف كل ما تعلّمه المساعد عنك من هذا الجهاز. ملاحظاتك اليدوية لن تُحذف. متابعة؟')) return;
    await clearLearnedProfile();
    await reload();
    setMessage('تم مسح ما تعلّمه المساعد.');
  }

  return (
    <div className="space-y-4">
      <label className="flex items-start justify-between gap-3 rounded-lg border border-base-border bg-base-card p-3">
        <span className="text-xs leading-6 text-text-secondary">
          <span className="block text-sm text-text-primary">التعلّم الشخصي</span>
          يتعلّم المساعد اسمك ولهجتك وأسلوبك واهتماماتك من محادثاتك، ويحفظها على هذا الجهاز فقط.
          عند التفعيل يُرسل هذا الملخص وملاحظاتك مع كل طلب إلى مزوّد الذكاء الاصطناعي ليخصص الرد، ولا تحفظه Smart.z.
        </span>
        <button type="button" role="switch" aria-checked={state.consent} onClick={toggleConsent}
          className={`relative mt-1 h-6 w-11 flex-shrink-0 rounded-full transition-colors ${state.consent ? 'bg-gold' : 'bg-base-border'}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${state.consent ? 'right-0.5' : 'right-[22px]'}`} />
        </button>
      </label>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text-primary">ما تعلّمه المساعد عنك</h3>
          {state.updatedAt && <span className="text-[11px] text-text-secondary">آخر تحديث {formatDate(state.updatedAt)}</span>}
        </div>

        {isProfileEmpty(profile) ? (
          <p className="rounded-lg border border-base-border bg-base-card px-4 py-4 text-xs leading-6 text-text-secondary">
            {state.consent
              ? 'لم يتعلّم شيئاً بعد. يبدأ بعد ثلاث رسائل تقريباً، أو اضغط «تعلّم الآن».'
              : 'التعلّم متوقف. فعّله من المفتاح أعلاه.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {profile.name && <Item label="الاسم" value={profile.name} onRemove={() => update({ name: '' })} />}
            {profile.dialect && <Item label="اللهجة" value={profile.dialect} onRemove={() => update({ dialect: '' })} />}
            {profile.speakingStyle && <Item label="الأسلوب" value={profile.speakingStyle} onRemove={() => update({ speakingStyle: '' })} />}
            {profile.preferences.map((item) => (
              <Item key={`p-${item}`} label="يفضّل" value={item}
                onRemove={() => update({ preferences: profile.preferences.filter((x) => x !== item) })} />
            ))}
            {profile.facts.map((item) => (
              <Item key={`f-${item}`} value={item}
                onRemove={() => update({ facts: profile.facts.filter((x) => x !== item) })} />
            ))}
          </ul>
        )}
      </section>

      <div className="grid grid-cols-2 gap-2">
        <button type="button" disabled={!state.consent || busy} onClick={learnNow}
          className="min-h-10 rounded-lg border border-gold/40 px-3 text-sm text-gold hover:bg-gold/10 disabled:opacity-50">
          {busy ? 'يتعلّم…' : 'تعلّم الآن'}
        </button>
        <button type="button" disabled={isProfileEmpty(profile)} onClick={clearAll}
          className="min-h-10 rounded-lg border border-base-border px-3 text-sm text-text-secondary hover:text-red-300 disabled:opacity-50">
          مسح ما تعلّمه
        </button>
      </div>
      {message && <p role="status" className="text-xs leading-5 text-text-secondary">{message}</p>}
      <p className="text-[11px] leading-5 text-text-secondary">
        الذاكرة على هذا الهاتف فقط: تضيع عند حذف التطبيق أو تغيير الهاتف أو دخول حساب آخر عليه.
      </p>
    </div>
  );
}
