/**
 * Shapes of study-tool results (shared by the /api/study route and the app).
 * Model output is never trusted: everything passes through normalizeStudyResult().
 */

export const STUDY_TYPES = ['summary', 'explain', 'quiz', 'cards', 'mindmap'];

const text = (value, max = 2000) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const page = (value) => (Number.isInteger(value) && value > 0 && value < 10_000 ? value : undefined);

export function normalizeStudyResult(type, raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  if (type === 'summary') {
    const points = (Array.isArray(data.points) ? data.points : [])
      .map((p) => ({ text: text(typeof p === 'string' ? p : p?.text, 600), page: page(p?.page) }))
      .filter((p) => p.text).slice(0, 40);
    return { overview: text(data.overview, 1500), points };
  }
  if (type === 'explain') return { text: text(data.text, 6000) };
  if (type === 'quiz') {
    const questions = (Array.isArray(data.questions) ? data.questions : []).map((q) => {
      const kind = ['mcq', 'tf', 'short'].includes(q?.type) ? q.type : 'mcq';
      const base = { type: kind, question: text(q?.question, 500), explanation: text(q?.explanation, 800), page: page(q?.page) };
      if (kind === 'mcq') {
        const options = (Array.isArray(q?.options) ? q.options : []).map((o) => text(o, 200)).filter(Boolean).slice(0, 5);
        const answer = Number.isInteger(q?.answer) ? q.answer : options.findIndex((o) => o === text(q?.answer, 200));
        return options.length >= 2 && answer >= 0 && answer < options.length ? { ...base, options, answer } : null;
      }
      if (kind === 'tf') {
        const answer = typeof q?.answer === 'boolean' ? q.answer : /^(true|صح|صحيح)$/i.test(String(q?.answer).trim()) ? true : /^(false|خطأ|خطا)$/i.test(String(q?.answer).trim()) ? false : null;
        return answer === null ? null : { ...base, answer };
      }
      const answer = text(q?.answer, 600);
      return answer ? { ...base, answer } : null;
    }).filter((q) => q && q.question).slice(0, 30);
    return { questions };
  }
  if (type === 'cards') {
    const cards = (Array.isArray(data.cards) ? data.cards : [])
      .map((c) => ({ front: text(c?.front, 300), back: text(c?.back, 800), page: page(c?.page) }))
      .filter((c) => c.front && c.back).slice(0, 60);
    return { cards };
  }
  if (type === 'mindmap') {
    const branches = (Array.isArray(data.branches) ? data.branches : [])
      .map((b) => ({ title: text(b?.title, 120), children: (Array.isArray(b?.children) ? b.children : []).map((c) => text(typeof c === 'string' ? c : c?.title, 160)).filter(Boolean).slice(0, 8) }))
      .filter((b) => b.title).slice(0, 10);
    return { root: text(data.root, 120), branches };
  }
  return null;
}

/** True when a result has enough content to show. */
export function isUsableStudyResult(type, result) {
  if (!result) return false;
  if (type === 'summary') return result.points.length > 0 || Boolean(result.overview);
  if (type === 'explain') return Boolean(result.text);
  if (type === 'quiz') return result.questions.length > 0;
  if (type === 'cards') return result.cards.length > 0;
  if (type === 'mindmap') return result.branches.length > 0;
  return false;
}
