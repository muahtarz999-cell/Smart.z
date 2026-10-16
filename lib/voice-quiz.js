/**
 * Spoken quiz: the assistant reads a question, the user answers with the talk
 * button, the answer is graded on the device, and the next question is read.
 * The page routes transcripts here (interceptTranscript) while a quiz is active.
 */
import { normalizeArabic, tokenize } from './arabic-normalize.js';

const ORDINALS = [
  ['1', 'اول', 'الاول', 'واحد', 'ا', 'أ'],
  ['2', 'ثاني', 'الثاني', 'اثنين', 'ب'],
  ['3', 'ثالث', 'الثالث', 'ثلاثه', 'ج'],
  ['4', 'رابع', 'الرابع', 'اربعه', 'د'],
  ['5', 'خامس', 'الخامس', 'خمسه', 'ه'],
];
const LETTERS = ['أ', 'ب', 'ج', 'د', 'هـ'];

export function questionToSpeech(question, number, total) {
  let spoken = `السؤال ${number} من ${total}. ${question.question}`;
  if (question.type === 'mcq') spoken += ' ' + question.options.map((option, i) => `${LETTERS[i]}: ${option}.`).join(' ');
  if (question.type === 'tf') spoken += ' صح أم خطأ؟';
  return spoken;
}

/** Returns true | false for a spoken/typed answer. */
export function gradeAnswer(question, answer) {
  const said = normalizeArabic(answer);
  if (!said) return false;
  if (question.type === 'tf') {
    const yes = /(^| )(صح|صحيح|نعم|ايه|اي|true)( |$)/.test(said);
    const no = /(^| )(خطا|غلط|خاطي|لا|false)( |$)/.test(said);
    if (yes === no) return false;
    return yes === question.answer;
  }
  if (question.type === 'mcq') {
    const words = said.split(' ');
    const chosen = ORDINALS.findIndex((forms) => forms.some((form) => words.includes(normalizeArabic(form))));
    if (chosen >= 0 && chosen < question.options.length) return chosen === question.answer;
    const scores = question.options.map((option) => overlap(tokenize(option), tokenize(answer)));
    const best = Math.max(...scores);
    return best >= 0.5 && scores.indexOf(best) === question.answer;
  }
  return overlap(tokenize(question.answer), tokenize(answer)) >= 0.5;
}

function overlap(expected, given) {
  if (!expected.length) return 0;
  const set = new Set(given);
  return expected.filter((word) => set.has(word) || [...set].some((g) => g.startsWith(word) || word.startsWith(g))).length / expected.length;
}

export function correctAnswerText(question) {
  if (question.type === 'mcq') return `${LETTERS[question.answer]}: ${question.options[question.answer]}`;
  if (question.type === 'tf') return question.answer ? 'صح' : 'خطأ';
  return question.answer;
}

// ---------------------------------------------------------------- session store
let session = null; // { questions, index, correct, onUpdate }

export function startVoiceQuiz(questions, onUpdate) {
  session = { questions, index: 0, correct: 0, onUpdate };
  onUpdate?.({ ...session });
  return questionToSpeech(questions[0], 1, questions.length);
}

export function isVoiceQuizActive() {
  return Boolean(session);
}

export function stopVoiceQuiz() {
  const finished = session;
  session = null;
  finished?.onUpdate?.(null);
}

/** Grades the answer and returns what to say next (feedback + next question, or the final score). */
export function answerVoiceQuiz(answer) {
  if (!session) return null;
  if (/^(وقف|اوقف|انه|انهي|خلاص|stop)/.test(normalizeArabic(answer))) {
    const score = `أوقفت الاختبار. نتيجتك ${session.correct} من ${session.index}.`;
    stopVoiceQuiz();
    return score;
  }
  const question = session.questions[session.index];
  const right = gradeAnswer(question, answer);
  if (right) session.correct += 1;
  const feedback = right
    ? `صح. ${question.explanation || ''}`
    : `خطأ. الإجابة الصحيحة: ${correctAnswerText(question)}. ${question.explanation || ''}`;
  session.index += 1;
  if (session.index >= session.questions.length) {
    const total = session.questions.length;
    const final = `${feedback} انتهى الاختبار. نتيجتك ${session.correct} من ${total}.`;
    session.onUpdate?.({ ...session, finished: true, lastRight: right });
    session = null;
    return final;
  }
  session.onUpdate?.({ ...session, lastRight: right });
  return `${feedback} ${questionToSpeech(session.questions[session.index], session.index + 1, session.questions.length)}`;
}
