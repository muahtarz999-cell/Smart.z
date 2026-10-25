/** Sentence-aware chunks no longer than `max` characters (shared by browser and server). */
export function splitForSpeech(text, max = 180) {
  const limit = Number.isInteger(max) && max > 0 ? max : 180;
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const sentences = normalized.match(/[^.!?؟،؛\n]+[.!?؟،؛\n]*/g) || [];
  const chunks = [];
  let current = '';

  const pushCurrent = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = '';
  };

  for (const sentence of sentences) {
    if (Array.from(sentence).length <= limit) {
      if (Array.from(current + sentence).length > limit) {
        pushCurrent();
      }
      current += sentence;
      continue;
    }

    pushCurrent();

    let piece = '';

    for (const word of sentence.split(' ')) {
      const characters = Array.from(word);

      // Preserve every character even when a single word exceeds the limit.
      if (characters.length > limit) {
        if (piece) {
          chunks.push(piece.trim());
          piece = '';
        }

        for (let offset = 0; offset < characters.length; offset += limit) {
          chunks.push(characters.slice(offset, offset + limit).join(''));
        }
        continue;
      }

      const candidate = piece ? `${piece} ${word}` : word;

      if (Array.from(candidate).length > limit) {
        if (piece) chunks.push(piece.trim());
        piece = word;
      } else {
        piece = candidate;
      }
    }

    if (piece.trim()) current = piece;
  }

  pushCurrent();
  return chunks;
}
