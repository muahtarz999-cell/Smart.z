/** Sentence-aware chunks no longer than `max` characters (shared by browser and server). */
export function splitForSpeech(text, max = 180) {
  const sentences = String(text || '').replace(/\s+/g, ' ').trim().match(/[^.!?؟،؛\n]+[.!?؟،؛\n]*/g) || [];
  const chunks = [];
  let current = '';
  const push = () => { if (current.trim()) chunks.push(current.trim()); current = ''; };
  for (const sentence of sentences) {
    if (sentence.length > max) {
      push();
      let piece = '';
      for (const word of sentence.split(' ')) {
        if ((piece + ' ' + word).trim().length > max) { if (piece) chunks.push(piece.trim()); piece = word.slice(0, max); }
        else piece = `${piece} ${word}`;
      }
      if (piece.trim()) current = piece;
      continue;
    }
    if ((current + sentence).length > max) push();
    current += sentence;
  }
  push();
  return chunks;
}
