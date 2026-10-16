const TRIGGER_ALIASES = [
  'Smart.z',
  'smartz',
  'سمارت زاد',
  'سمارت زد',
  'سمارت زي',
  'سمارت ز',
  'سمارتزاد',
  'سمارتزد',
  'يا سمارت زاد',
  'يا سمارت زد',
  'يا سمارت',
  'يارسمارت',
  'المساعد',
  'يا مساعد',
];

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function differsByAtMostOneCharacter(left, right) {
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left === right) return true;

  let leftIndex = 0;
  let rightIndex = 0;
  let differences = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    differences += 1;
    if (differences > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }

  return differences + Number(leftIndex < left.length || rightIndex < right.length) <= 1;
}

const NORMALIZED_ALIASES = TRIGGER_ALIASES
  .map(normalizeText)
  .map((alias) => alias.split(' '))
  .sort((left, right) => right.length - left.length);

function isAliasMatch(aliasWords, transcriptWords) {
  if (aliasWords.length > transcriptWords.length) return false;

  return aliasWords.every((aliasWord, index) => {
    const transcriptWord = transcriptWords[index];
    if (aliasWord === transcriptWord) return true;

    return aliasWord.length >= 3
      && transcriptWord.length >= 3
      && differsByAtMostOneCharacter(aliasWord, transcriptWord);
  });
}

export function resolveVoiceTrigger(transcript) {
  const originalText = String(transcript ?? '').trim();
  const normalized = normalizeText(transcript);
  if (!normalized) return { triggered: false, text: '' };

  const words = normalized.split(' ');
  let match = null;
  for (let index = 0; index < words.length && !match; index += 1) {
    const candidate = NORMALIZED_ALIASES.find((alias) =>
      isAliasMatch(alias, words.slice(index))
    );
    if (candidate) match = { candidate, index };
  }
  if (!match) return { triggered: false, text: originalText };
  const originalWords = [...originalText.matchAll(/[\p{L}\p{M}\p{N}]+/gu)];
  const firstAliasWord = originalWords[match.index];
  const lastAliasWord = originalWords[match.index + match.candidate.length - 1];
  const before = firstAliasWord
    ? originalText.slice(0, firstAliasWord.index).replace(/[\s\p{P}\p{S}\p{M}]+$/u, '')
    : '';
  const after = lastAliasWord
    ? originalText.slice(lastAliasWord.index + lastAliasWord[0].length)
      .replace(/^[\s\p{P}\p{S}\p{M}]+/u, '')
    : '';
  const text = [before, after].filter(Boolean).join(' ').trim();

  return {
    triggered: true,
    text,
  };
}
