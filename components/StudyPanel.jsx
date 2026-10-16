'use client';

/**
 * "المذاكرة": summary, explanation (read aloud), quiz (on screen or spoken),
 * spaced-repetition cards, mind map, and a study plan with reminders —
 * all from a file in "ملفاتي". Results are kept on this device.
 */

import { useEffect, useState } from 'react';
import { listFiles } from '../lib/file-store';
import { createStudyPlan, deleteStudySet, dueCards, gradeCard, listStudySets, runStudyTool } from '../lib/study';
import { correctAnswerText, gradeAnswer, startVoiceQuiz, stopVoiceQuiz } from '../lib/voice-quiz';
import { primeSpeech, speak, stopSpeaking } from '../lib/speech';

const TOOLS = [
  ['summary', 'ملخص'], ['explain', 'اشرح لي'], ['quiz', 'اختبرني'], ['cards', 'بطاقات'], ['mindmap', 'خريطة ذهنية'], ['plan', 'خطة مذاكرة'],
];
const TYPE_LABEL = Object.fromEntries(TOOLS);
const chip = 'rounded-md border border-base-border px-3 py-1.5 text-xs text-text-primary hover:bg-base-panel disabled:opacity-50';

function speakText(text) {
  primeSpeech();
  speak(text).catch(() => {});
}

export default function StudyPanel({ getAccessToken, initialFileId }) {
  const [files, setFiles] = useState(null);
  const [fileId, setFileId] = useState(initialFileId || '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [sets, setSets] = useState([]);
  const [active, setActive] = useState(null);
  const [topic, setTopic] = useState('');

  useEffect(() => {
    listFiles().then((all) => {
      const usable = all.filter((f) => f.kind !== 'image' && !f.scanned);
      setFiles(usable);
      if (!fileId && usable[0]) setFileId(usable[0].id);
    }).catch(() => setFiles([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (initialFileId) setFileId(initialFileId); }, [initialFileId]);
  useEffect(() => { if (fileId) listStudySets(fileId).then(setSets).catch(() => setSets([])); }, [fileId]);

  const file = files?.find((f) => f.id === fileId);

  async function run(type) {
    if (!file) return;
    if (type === 'plan') { setActive({ type: 'plan' }); return; }
    setBusy('جارٍ التجهيز…');
    setError('');
    try {
      const set = await runStudyTool({
        getAccessToken, file, type,
        from: Number(from) || undefined, to: Number(to) || undefined,
        options: type === 'explain' ? { topic } : type === 'quiz' ? { count: 10 } : type === 'cards' ? { count: 20 } : {},
        onProgress: setBusy,
      });
      setSets((current) => [set, ...current]);
      setActive(set);
      if (type === 'explain') speakText(set.result.text);
    } catch (runError) {
      setError(runError.message);
    } finally {
      setBusy('');
    }
  }

  if (files === null) return <p className="text-sm text-text-secondary">جارٍ التحميل…</p>;
  if (!files.length) {
    return (
      <div className="space-y-2">
        <h2 className="text-base font-semibold text-text-primary">المذاكرة</h2>
        <p className="rounded-lg border border-base-border bg-base-card px-4 py-5 text-sm leading-7 text-text-secondary">أضف ملف PDF أو Word من «ملفاتي» أولاً، ثم ارجع هنا للتلخيص والاختبار والبطاقات.</p>
      </div>
    );
  }

  if (active) {
    return (
      <div className="space-y-3">
        <button type="button" onClick={() => { stopSpeaking(); stopVoiceQuiz(); setActive(null); }} className="text-xs text-text-secondary">→ أدوات المذاكرة</button>
        {active.type === 'summary' && <SummaryView set={active} />}
        {active.type === 'explain' && <ExplainView set={active} />}
        {active.type === 'quiz' && <QuizView set={active} />}
        {active.type === 'cards' && <CardsView set={active} />}
        {active.type === 'mindmap' && <MindmapView set={active} />}
        {active.type === 'plan' && <PlanView file={file} from={Number(from) || 1} to={Number(to) || file.pageCount} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-text-primary">المذاكرة</h2>
        <p className="mt-1 text-xs leading-5 text-text-secondary">من ملفاتك المحفوظة على الجهاز. يُرسل نص النطاق المختار فقط للتحليل.</p>
      </div>
      <label className="block space-y-1.5">
        <span className="text-xs text-text-secondary">الملف</span>
        <select value={fileId} onChange={(e) => setFileId(e.target.value)} className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-sm text-text-primary">
          {files.map((f) => <option key={f.id} value={f.id}>{f.name}{f.pageCount > 1 ? ` (${f.pageCount} ص)` : ''}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1"><span className="text-xs text-text-secondary">من صفحة</span>
          <input type="number" min={1} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="1" className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-sm text-text-primary" /></label>
        <label className="space-y-1"><span className="text-xs text-text-secondary">إلى صفحة</span>
          <input type="number" min={1} value={to} onChange={(e) => setTo(e.target.value)} placeholder={String(file?.pageCount || '')} className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-sm text-text-primary" /></label>
      </div>
      <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="لـ«اشرح لي»: ما الذي تريد شرحه؟ (اختياري)"
        className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-sm text-text-primary" />
      <div className="grid grid-cols-3 gap-2">
        {TOOLS.map(([type, label]) => (
          <button key={type} type="button" disabled={Boolean(busy)} onClick={() => run(type)}
            className="min-h-11 rounded-lg border border-gold/40 bg-gold/5 px-2 text-sm text-gold disabled:opacity-50">{label}</button>
        ))}
      </div>
      {busy && <p role="status" className="text-xs text-text-secondary">{busy}</p>}
      {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}

      {sets.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs text-text-secondary">محفوظ لهذا الملف</h3>
          <ul className="space-y-1.5">
            {sets.map((set) => (
              <li key={set.id} className="flex items-center gap-2">
                <button type="button" onClick={() => setActive(set)} className="min-w-0 flex-1 rounded-md border border-base-border bg-base-card px-3 py-2 text-right text-xs text-text-primary">
                  {TYPE_LABEL[set.type]}{set.from ? ` · ص${set.from}–${set.to || ''}` : ''} · {new Date(set.createdAt).toLocaleDateString('ar')}
                </button>
                <button type="button" onClick={async () => { await deleteStudySet(set.id); setSets((c) => c.filter((s) => s.id !== set.id)); }}
                  className="text-[11px] text-text-secondary hover:text-red-300">حذف</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SummaryView({ set }) {
  const { overview, points } = set.result;
  const spoken = [overview, ...points.map((p) => p.text)].filter(Boolean).join('. ');
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-text-primary">الملخص</h3>
        <button type="button" className={chip} onClick={() => speakText(spoken)}>اقرأه لي</button></div>
      {overview && <p className="text-[15px] leading-8 text-text-primary">{overview}</p>}
      <ul className="space-y-2">
        {points.map((point, i) => (
          <li key={i} className="flex gap-2 text-[15px] leading-8 text-text-primary">
            <span className="text-gold">•</span><span className="flex-1">{point.text}{point.page ? <span className="mr-1 text-[11px] text-text-secondary">(ص{point.page})</span> : null}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExplainView({ set }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-text-primary">الشرح</h3>
        <div className="flex gap-2"><button type="button" className={chip} onClick={() => speakText(set.result.text)}>اقرأه</button>
          <button type="button" className={chip} onClick={stopSpeaking}>إيقاف</button></div></div>
      <p className="whitespace-pre-line text-[16px] leading-8 text-text-primary">{set.result.text}</p>
    </div>
  );
}

function QuizView({ set }) {
  const { questions } = set.result;
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState(null);
  const [shortAnswer, setShortAnswer] = useState('');
  const [score, setScore] = useState(0);
  const [voice, setVoice] = useState(null);
  const question = questions[index];
  const done = index >= questions.length;

  if (voice) {
    return (
      <div className="space-y-3 text-center">
        <h3 className="text-sm font-semibold text-text-primary">الاختبار الصوتي</h3>
        <p className="text-xs leading-6 text-text-secondary">اضغط زر التحدث في الشاشة الرئيسية وقل إجابتك («الأول»، «صح»، أو الإجابة نفسها). قل «وقف» للإنهاء.</p>
        <p className="text-2xl font-semibold text-gold">{voice.finished ? 'انتهى' : `${Math.min(voice.index + 1, questions.length)} / ${questions.length}`}</p>
        <p className="text-sm text-text-primary">الإجابات الصحيحة: {voice.correct}</p>
        <button type="button" className={chip} onClick={() => { stopVoiceQuiz(); stopSpeaking(); setVoice(null); }}>إنهاء</button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="space-y-3 text-center">
        <p className="text-lg font-semibold text-text-primary">نتيجتك {score} من {questions.length}</p>
        <button type="button" className={chip} onClick={() => { setIndex(0); setScore(0); setPicked(null); }}>أعد الاختبار</button>
      </div>
    );
  }

  const answered = picked !== null;
  const right = answered && (question.type === 'short' ? gradeAnswer(question, shortAnswer) : picked === question.answer);
  const choose = (value) => { if (answered) return; setPicked(value); if (question.type === 'short' ? gradeAnswer(question, shortAnswer) : value === question.answer) setScore((s) => s + 1); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-secondary">سؤال {index + 1} من {questions.length}</span>
        <button type="button" className={chip} onClick={() => {
          primeSpeech();
          const first = startVoiceQuiz(questions, setVoice);
          speak(first).catch(() => {});
          setVoice({ index: 0, correct: 0 });
        }}>اختبار صوتي</button>
      </div>
      <p className="text-[16px] leading-8 text-text-primary">{question.question}</p>
      {question.type === 'mcq' && question.options.map((option, i) => (
        <button key={i} type="button" onClick={() => choose(i)}
          className={`block w-full rounded-lg border px-3 py-2 text-right text-sm leading-7 ${answered && i === question.answer ? 'border-emerald-400/60 bg-emerald-500/10' : answered && i === picked ? 'border-red-400/60 bg-red-500/10' : 'border-base-border bg-base-card'} text-text-primary`}>
          {option}
        </button>
      ))}
      {question.type === 'tf' && (
        <div className="grid grid-cols-2 gap-2">
          {[[true, 'صح'], [false, 'خطأ']].map(([value, label]) => (
            <button key={label} type="button" onClick={() => choose(value)}
              className={`min-h-10 rounded-lg border text-sm ${answered && value === question.answer ? 'border-emerald-400/60 bg-emerald-500/10' : answered && value === picked ? 'border-red-400/60 bg-red-500/10' : 'border-base-border bg-base-card'} text-text-primary`}>{label}</button>
          ))}
        </div>
      )}
      {question.type === 'short' && (
        <div className="space-y-2">
          <textarea rows={2} value={shortAnswer} disabled={answered} onChange={(e) => setShortAnswer(e.target.value)} dir="auto"
            className="w-full rounded-lg border border-base-border bg-base-panel px-3 py-2 text-sm text-text-primary" />
          {!answered && <button type="button" className={chip} disabled={!shortAnswer.trim()} onClick={() => choose('short')}>تحقق</button>}
        </div>
      )}
      {answered && (
        <div className={`rounded-lg p-3 text-sm leading-7 ${right ? 'bg-emerald-500/10 text-emerald-200' : 'bg-red-500/10 text-red-200'}`}>
          {right ? 'صح! ' : `الإجابة: ${correctAnswerText(question)}. `}{question.explanation}{question.page ? ` (ص${question.page})` : ''}
        </div>
      )}
      {answered && (
        <button type="button" className="min-h-10 w-full rounded-lg bg-gold text-sm font-semibold text-base-bg"
          onClick={() => { setIndex(index + 1); setPicked(null); setShortAnswer(''); }}>{index + 1 < questions.length ? 'التالي' : 'النتيجة'}</button>
      )}
    </div>
  );
}

function CardsView({ set }) {
  const [queue, setQueue] = useState(null);
  const [flipped, setFlipped] = useState(false);
  useEffect(() => { dueCards(set).then(setQueue).catch(() => setQueue([])); }, [set]);
  if (!queue) return <p className="text-sm text-text-secondary">جارٍ التحميل…</p>;
  if (!queue.length) {
    return <p className="rounded-lg border border-base-border bg-base-card p-4 text-center text-sm leading-7 text-text-secondary">لا توجد بطاقات مستحقة الآن ({set.result.cards.length} بطاقة). ارجع لاحقاً حسب جدول المراجعة.</p>;
  }
  const current = queue[0];
  const grade = async (value) => {
    await gradeCard(set.id, current.id, value);
    setFlipped(false);
    setQueue((q) => (value < 3 ? [...q.slice(1), current] : q.slice(1)));
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-text-secondary">متبقٍ للمراجعة الآن: {queue.length}</p>
      <button type="button" onClick={() => setFlipped(!flipped)}
        className="flex min-h-48 w-full items-center justify-center rounded-xl border border-gold/40 bg-base-card p-5 text-center text-[17px] leading-8 text-text-primary">
        {flipped ? current.card.back : current.card.front}
      </button>
      {!flipped ? <p className="text-center text-[11px] text-text-secondary">اضغط البطاقة لرؤية الإجابة</p> : (
        <div className="grid grid-cols-4 gap-1.5">
          {[[0, 'نسيت'], [3, 'صعب'], [4, 'جيد'], [5, 'سهل']].map(([value, label]) => (
            <button key={label} type="button" onClick={() => grade(value)} className={chip}>{label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function MindmapView({ set }) {
  const { root, branches } = set.result;
  return (
    <div className="space-y-3">
      <p className="rounded-lg bg-gold/15 px-4 py-3 text-center text-base font-semibold text-gold">{root}</p>
      <div className="space-y-2">
        {branches.map((branch, i) => (
          <div key={i} className="rounded-lg border border-base-border bg-base-card p-3">
            <p className="text-sm font-semibold text-text-primary">{branch.title}</p>
            <ul className="mt-1.5 space-y-1 border-r-2 border-gold/40 pr-3">
              {branch.children.map((child, j) => <li key={j} className="text-[13px] leading-6 text-text-secondary">{child}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlanView({ file, from, to }) {
  const [examDate, setExamDate] = useState('');
  const [hour, setHour] = useState(19);
  const [result, setResult] = useState('');
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-text-primary">خطة مذاكرة: {file.name}</h3>
      <p className="text-xs text-text-secondary">الصفحات {from} إلى {to}. تُضاف مهام يومية بتذكيرات في «مهامي»، ويوم أخير للمراجعة.</p>
      <label className="block space-y-1"><span className="text-xs text-text-secondary">تاريخ الاختبار</span>
        <input type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-sm text-text-primary" /></label>
      <label className="block space-y-1"><span className="text-xs text-text-secondary">ساعة التذكير اليومية</span>
        <select value={hour} onChange={(e) => setHour(Number(e.target.value))} className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-sm text-text-primary">
          {[7, 9, 13, 16, 18, 19, 20, 21, 22].map((h) => <option key={h} value={h}>{h}:00</option>)}
        </select></label>
      <button type="button" disabled={!examDate} className="min-h-10 w-full rounded-lg bg-gold text-sm font-semibold text-base-bg disabled:opacity-50" onClick={async () => {
        try {
          const { tasks, perDay } = await createStudyPlan({ file, examDate, from, to, hour });
          setResult(`أُضيفت ${tasks.length} مهمة: نحو ${perDay} صفحة يومياً.`);
        } catch (error) { setResult(error.message); }
      }}>أنشئ الخطة</button>
      {result && <p role="status" className="text-xs leading-6 text-text-secondary">{result}</p>}
    </div>
  );
}
