/**
 * The learned user profile: a short, human-readable summary of what the
 * assistant knows about its user. Shared by the browser (stores it) and the
 * server (validates it and turns it into instructions). Never trust either
 * side's copy blindly: everything goes through sanitizeProfile().
 *
 * Stored only on the user's device. Sent with a request only when the user
 * has given consent.
 */

export const PROFILE_LIMITS = Object.freeze({
  name: 60,
  dialect: 80,
  speakingStyle: 240,
  preferences: { count: 10, length: 140 },
  facts: { count: 25, length: 180 },
  memories: { count: 15, length: 240 },
});

export const EMPTY_PROFILE = Object.freeze({
  name: '',
  dialect: '',
  speakingStyle: '',
  preferences: [],
  facts: [],
});

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanList(value, { count, length }) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const text = cleanText(typeof item === 'string' ? item : item?.text, length);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= count) break;
  }
  return out;
}

export function sanitizeProfile(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    name: cleanText(source.name, PROFILE_LIMITS.name),
    dialect: cleanText(source.dialect, PROFILE_LIMITS.dialect),
    speakingStyle: cleanText(source.speakingStyle, PROFILE_LIMITS.speakingStyle),
    preferences: cleanList(source.preferences, PROFILE_LIMITS.preferences),
    facts: cleanList(source.facts, PROFILE_LIMITS.facts),
  };
}

export function sanitizeMemories(raw) {
  return cleanList(raw, PROFILE_LIMITS.memories);
}

export function isProfileEmpty(profile) {
  const p = sanitizeProfile(profile);
  return !p.name && !p.dialect && !p.speakingStyle && p.preferences.length === 0 && p.facts.length === 0;
}

/** Turns the profile + the user's own notes into a system-prompt block, or '' when there is nothing. */
export function profileToPrompt(profile, memories = []) {
  const p = sanitizeProfile(profile);
  const notes = sanitizeMemories(memories);
  const lines = [];
  if (p.name) lines.push(`- الاسم: ${p.name}`);
  if (p.dialect) lines.push(`- اللهجة: ${p.dialect}`);
  if (p.speakingStyle) lines.push(`- أسلوبه في الكلام: ${p.speakingStyle}`);
  for (const item of p.preferences) lines.push(`- يفضّل: ${item}`);
  for (const item of p.facts) lines.push(`- ${item}`);
  for (const item of notes) lines.push(`- (دوّنها المستخدم بنفسه) ${item}`);
  if (!lines.length) return '';
  return [
    'ما تعرفه عن المستخدم من محادثات سابقة وملاحظاته:',
    ...lines,
    'استخدم هذه المعلومات بطبيعية لتخصيص الرد، وخاطبه بلهجته إن كانت معروفة. لا تسردها ولا تقل إنك تحفظها إلا إذا سألك عمّا تعرفه عنه.',
  ].join('\n');
}
