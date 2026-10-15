'use client';

/**
 * On-device learning. The learned profile and the consent flag live in the
 * `learning` IndexedDB store on this phone only. Every few turns, if the user
 * consented, the recent conversation is summarised into the profile through
 * /api/learn (stateless). The profile then travels with each request so the
 * assistant can personalise its replies.
 */

import { openLocalDatabase, listLocalRecords } from './local-data';
import { getRecentMessages } from './conversation';
import { EMPTY_PROFILE, isProfileEmpty, sanitizeMemories, sanitizeProfile } from './learned-profile';

const STORE = 'learning';
const PROFILE_ID = 'profile';
const CONSENT_ID = 'consent';
const LEARN_EVERY_USER_TURNS = 3;

function transaction(mode, work) {
  return openLocalDatabase().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    Promise.resolve(work(store, (value) => { result = value; })).catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Learning storage failed.'));
    tx.onabort = () => reject(tx.error || new Error('Learning storage was aborted.'));
  }));
}

function get(id) {
  return transaction('readonly', (store, done) => {
    const request = store.get(id);
    request.onsuccess = () => done(request.result || null);
  });
}

function put(record) {
  return transaction('readwrite', (store) => { store.put(record); });
}

export async function getLearningState() {
  const [profileRecord, consentRecord] = await Promise.all([get(PROFILE_ID), get(CONSENT_ID)]);
  return {
    consent: consentRecord?.granted === true,
    consentAt: consentRecord?.at || null,
    profile: sanitizeProfile(profileRecord?.profile || EMPTY_PROFILE),
    learnedThrough: profileRecord?.learnedThrough || 0,
    updatedAt: profileRecord?.updatedAt || null,
  };
}

export async function setLearningConsent(granted) {
  await put({ id: CONSENT_ID, granted: Boolean(granted), at: Date.now() });
}

export async function saveLearnedProfile(profile, learnedThrough) {
  const current = await get(PROFILE_ID);
  await put({
    id: PROFILE_ID,
    profile: sanitizeProfile(profile),
    learnedThrough: learnedThrough ?? current?.learnedThrough ?? 0,
    updatedAt: Date.now(),
  });
}

export async function clearLearnedProfile() {
  await put({ id: PROFILE_ID, profile: { ...EMPTY_PROFILE }, learnedThrough: Date.now(), updatedAt: Date.now() });
}

/** What travels with an assistant request: nothing without consent. */
export async function getAssistantContext() {
  try {
    const state = await getLearningState();
    if (!state.consent) return {};
    const memories = sanitizeMemories((await listLocalRecords('memories')).map((record) => record.text));
    return {
      profile: isProfileEmpty(state.profile) ? undefined : state.profile,
      memories: memories.length ? memories : undefined,
    };
  } catch {
    return {}; // learning must never break a conversation
  }
}

let learning = null;

/**
 * Call after each completed turn. Learns when at least 3 new user turns have
 * accumulated since the last update, or immediately with { force: true }.
 * Returns the new profile, or null when nothing was done.
 */
export function learnFromRecentConversation({ getAccessToken, force = false } = {}) {
  if (learning) return learning;
  learning = (async () => {
    const state = await getLearningState();
    if (!state.consent) return null;

    const recent = (await getRecentMessages(20)).filter((message) => (message.created_at || 0) > state.learnedThrough);
    const userTurns = recent.filter((message) => message.role === 'user').length;
    if (!userTurns || (!force && userTurns < LEARN_EVERY_USER_TURNS)) return null;

    const token = await getAccessToken?.();
    if (!token) return null;
    const response = await fetch('/api/learn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        profile: state.profile,
        messages: recent.map(({ role, content }) => ({ role, content })),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.profile) throw new Error(data.message || 'تعذر تحديث ملف التعلّم.');

    const learnedThrough = Math.max(...recent.map((message) => message.created_at || 0));
    await saveLearnedProfile(data.profile, learnedThrough);
    return sanitizeProfile(data.profile);
  })().finally(() => { learning = null; });
  return learning;
}
