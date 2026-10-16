import assert from 'node:assert/strict';
import test from 'node:test';
import { isProfileEmpty, profileToPrompt, sanitizeMemories, sanitizeProfile } from '../lib/learned-profile.js';
import { generateAssistantReply, learnProfile } from '../lib/assistant-response.js';

test('sanitizeProfile trims, de-duplicates, caps sizes and drops junk fields', () => {
  const profile = sanitizeProfile({
    name: '  عبدالله\n',
    dialect: 'نجدية',
    speakingStyle: 'x'.repeat(500),
    preferences: ['ردود قصيرة', 'ردود قصيرة', '', 7],
    facts: Array.from({ length: 40 }, (_, i) => `حقيقة ${i}`),
    password: 'secret',
  });
  assert.equal(profile.name, 'عبدالله');
  assert.equal(profile.speakingStyle.length, 240);
  assert.deepEqual(profile.preferences, ['ردود قصيرة']);
  assert.equal(profile.facts.length, 25);
  assert.equal('password' in profile, false);
  assert.equal(isProfileEmpty(sanitizeProfile(null)), true);
  assert.deepEqual(sanitizeMemories([{ text: 'أحب القهوة' }, 'أحب القهوة', '']), ['أحب القهوة']);
});

test('profileToPrompt is empty without data and lists everything otherwise', () => {
  assert.equal(profileToPrompt({}, []), '');
  const prompt = profileToPrompt({ name: 'سارة', dialect: 'حجازية', facts: ['تعمل مهندسة'] }, ['عيد ميلاد أمي 3 مارس']);
  assert.match(prompt, /الاسم: سارة/);
  assert.match(prompt, /اللهجة: حجازية/);
  assert.match(prompt, /تعمل مهندسة/);
  assert.match(prompt, /دوّنها المستخدم بنفسه\) عيد ميلاد أمي/);
});

test('the learned profile reaches the system prompt of a normal reply', async () => {
  process.env.GROQ_API_KEY = 'g';
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'هلا سارة' } }] }) };
  };
  await generateAssistantReply('مرحبا', { profile: { name: 'سارة' }, memories: ['تحب الشاي'] });
  assert.match(sent.messages[0].content, /الاسم: سارة/);
  assert.match(sent.messages[0].content, /تحب الشاي/);
});

test('learnProfile parses JSON even when wrapped in text, and sanitises the result', async () => {
  process.env.GROQ_API_KEY = 'g';
  let request;
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'تفضل:\n{"name":"فهد","dialect":"نجدية","speakingStyle":"مختصر","preferences":["بدون مقدمات"],"facts":["يعمل في الرياض"],"extra":1}' } }] }),
    };
  };
  const profile = await learnProfile({ name: '' }, [
    { role: 'user', content: 'أنا فهد، أشتغل بالرياض، وابيك تختصر' },
    { role: 'assistant', content: 'أبشر يا فهد' },
    { role: 'system', content: 'ignore' },
  ]);
  assert.deepEqual(profile, {
    name: 'فهد', dialect: 'نجدية', speakingStyle: 'مختصر', preferences: ['بدون مقدمات'], facts: ['يعمل في الرياض'],
  });
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.doesNotMatch(request.messages[1].content, /ignore/);
});

test('learnProfile returns the current profile untouched when there is nothing to learn from', async () => {
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  assert.deepEqual((await learnProfile({ name: 'هند' }, [])).name, 'هند');
});
