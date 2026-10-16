/**
 * BM25 search over a file's text chunks, entirely on the device. Used to send
 * only the passages that answer the question instead of the whole file.
 */
import { tokenize } from './arabic-normalize.js';

const K1 = 1.4;
const B = 0.75;

/** chunks: [{ id, text, page? }] → top `limit` chunks by relevance (score > 0). */
export function searchChunks(chunks, query, { limit = 6 } = {}) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !chunks.length) return [];
  const documents = chunks.map((chunk) => {
    const tokens = tokenize(chunk.text);
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    return { chunk, counts, length: tokens.length || 1 };
  });
  const averageLength = documents.reduce((sum, d) => sum + d.length, 0) / documents.length;
  const idf = new Map(terms.map((term) => {
    const containing = documents.filter((d) => d.counts.has(term) || [...d.counts.keys()].some((k) => k.startsWith(term))).length;
    return [term, Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5))];
  }));
  return documents
    .map((d) => {
      let score = 0;
      for (const term of terms) {
        // Exact token, or a prefix match at half weight (Arabic suffixes: كتاب → كتابه، كتابين).
        let frequency = d.counts.get(term) || 0;
        if (!frequency) for (const [token, count] of d.counts) if (token.startsWith(term)) frequency += count * 0.5;
        if (!frequency) continue;
        score += idf.get(term) * ((frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * d.length) / averageLength)));
      }
      return { ...d.chunk, score };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Splits page texts into ~size-character chunks on sentence boundaries, keeping page numbers. */
export function chunkPages(pages, size = 800) {
  const chunks = [];
  pages.forEach((text, pageIndex) => {
    const sentences = String(text || '').replace(/\s+/g, ' ').trim().match(/[^.!?؟\n]+[.!?؟\n]*/g) || [];
    let current = '';
    let index = 0;
    const push = () => {
      if (current.trim()) chunks.push({ page: pageIndex + 1, index: index++, text: current.trim() });
      current = '';
    };
    for (const sentence of sentences) {
      if ((current + sentence).length > size && current) push();
      current += sentence.length > size * 2 ? sentence.slice(0, size * 2) : sentence;
    }
    push();
  });
  return chunks;
}
