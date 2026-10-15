/** Arabic-aware normalisation for search and matching (no diacritics or tatweel, unified letter forms). */
export function normalizeArabic(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_WORDS = new Set(['في', 'من', 'على', 'الى', 'الي', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'ما', 'او', 'ان', 'كان', 'كل', 'هو', 'هي', 'وش', 'ايش', 'the', 'a', 'of', 'and', 'to', 'in', 'is']);

/** Tokens for search: normalised words, minus stop words, with the Arabic definite article stripped. */
export function tokenize(value) {
  return normalizeArabic(value)
    .split(' ')
    .map((word) => (word.length > 4 && /^(وال|بال|كال|فال|لل)/.test(word) ? word.slice(3) : word))
    .map((word) => (word.length > 3 && word.startsWith('ال') ? word.slice(2) : word))
    .filter((word) => word && !STOP_WORDS.has(word));
}
