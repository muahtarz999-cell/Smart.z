import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Minimal in-memory stand-in for the parts of IndexedDB lib/learning.js uses.
function fakeDatabase() {
  const data = new Map();
  return {
    data,
    transaction() {
      const tx = {};
      const pending = [];
      tx.objectStore = () => ({
        get(id) {
          const request = {};
          pending.push(() => { request.result = data.get(id); request.onsuccess?.(); });
          return request;
        },
        put(record) { pending.push(() => data.set(record.id, structuredClone(record))); },
      });
      setTimeout(() => { pending.forEach((run) => run()); setTimeout(() => tx.oncomplete?.(), 0); }, 0);
      return tx;
    },
  };
}

const source = (await readFile(new URL('../lib/learning.js', import.meta.url), 'utf8'))
  .replace("import { openLocalDatabase, listLocalRecords } from './local-data';",
    'const openLocalDatabase = async () => globalThis.__db; const listLocalRecords = async () => globalThis.__memories;')
  .replace("import { getRecentMessages } from './conversation';",
    'const getRecentMessages = async () => globalThis.__messages;')
  .replace("from './learned-profile';", `from '${new URL('../lib/learned-profile.js', import.meta.url).href}';`);
const learning = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function reset(messages = []) {
  globalThis.__db = fakeDatabase();
  globalThis.__memories = [{ text: 'يحب القهوة' }];
  globalThis.__messages = messages;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ profile: { name: 'فهد', facts: ['من الرياض'] } }) };
  };
  return calls;
}

const turns = (n, start = 1) => Array.from({ length: n * 2 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user', content: `رسالة ${i}`, created_at: start + i,
}));

test('nothing is sent and nothing is learned without consent', async () => {
  const calls = reset(turns(5));
  assert.deepEqual(await learning.getAssistantContext(), {});
  assert.equal(await learning.learnFromRecentConversation({ getAccessToken: async () => 't' }), null);
  assert.equal(calls.length, 0);
});

test('with consent: learns after 3 user turns, stores the profile, and does not relearn the same turns', async () => {
  const calls = reset(turns(2));
  await learning.setLearningConsent(true);
  assert.equal(await learning.learnFromRecentConversation({ getAccessToken: async () => 't' }), null, 'only 2 user turns');

  globalThis.__messages = turns(3);
  const profile = await learning.learnFromRecentConversation({ getAccessToken: async () => 't' });
  assert.equal(profile.name, 'فهد');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messages.length, 6);

  const state = await learning.getLearningState();
  assert.equal(state.profile.name, 'فهد');
  assert.equal(state.learnedThrough, 6);
  assert.equal(await learning.learnFromRecentConversation({ getAccessToken: async () => 't', force: true }), null, 'no new turns');

  const context = await learning.getAssistantContext();
  assert.equal(context.profile.name, 'فهد');
  assert.deepEqual(context.memories, ['يحب القهوة']);
});

test('clearing the profile keeps consent and empties what is sent', async () => {
  reset(turns(3));
  await learning.setLearningConsent(true);
  await learning.learnFromRecentConversation({ getAccessToken: async () => 't' });
  await learning.clearLearnedProfile();
  const state = await learning.getLearningState();
  assert.equal(state.consent, true);
  assert.equal(state.profile.name, '');
  assert.equal((await learning.getAssistantContext()).profile, undefined);
});
