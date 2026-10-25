
/** Sentence-aware speech chunks with no lost characters. */
export function splitForSpeech(text, max = 180) {
  const limit = Number.isInteger(max) && max > 0 ? max : 180;
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();

  if (!normalized) return [];

  const sentences =
    normalized.match(/[^.!?؟،؛]+[.!?؟،؛]*/g) || [];

  const chunks = [];
  let current = '';

  const length = (value) => Array.from(value).length;

  const pushCurrent = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = '';
  };

  for (const sentence of sentences) {
    if (length(sentence) <= limit) {
      if (length(current + sentence) > limit) {
        pushCurrent();
      }

      current += sentence;
      continue;
    }

    pushCurrent();

    const words = sentence.trim().split(' ');
    let piece = '';

    for (const word of words) {
      const wordChars = Array.from(word);

      // A single word can exceed the limit. Split it without dropping text.
      if (wordChars.length > limit) {
        if (piece) {
          chunks.push(piece);
          piece = '';
        }

        for (let offset = 0; offset < wordChars.length; offset += limit) {
          chunks.push(wordChars.slice(offset, offset + limit).join(''));
        }

        continue;
      }

      const candidate = piece ? `${piece} ${word}` : word;

      if (length(candidate) > limit) {
        if (piece) chunks.push(piece);
        piece = word;
      } else {
        piece = candidate;
      }
    }

    if (piece) current = piece;
  }

  pushCurrent();
  return chunks;
}
