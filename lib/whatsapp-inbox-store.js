'use client';

/**
 * Incoming WhatsApp messages on this phone (IndexedDB store "whatsappInbox").
 *
 *  - syncInbox: collects what waits on the customer's WhatsApp node, saves it
 *    here, then confirms so the node forgets it (the server keeps nothing).
 *  - runHousekeeping: deletes messages older than the retention period the
 *    customer picked (default 7 days) and, once a week, clears leftover
 *    speech cache. Runs at start-up and after every sync.
 */
import { getAllRecords, idbRequest, withStores } from './idb';
import { LOCAL_DATA_STORES } from './local-data';
import { clearSpeechCache } from './tts';
import {
  buildInboxContext,
  DEFAULT_INBOX_RETENTION_DAYS,
  isInboxQuestion,
  normalizeRetentionDays,
  sanitizeInboxItems,
} from './whatsapp-inbox';

const STORE = LOCAL_DATA_STORES.whatsappInbox;
const RETENTION_KEY = 'smart-z-inbox-retention-days';
const LAST_CACHE_CLEAN_KEY = 'smart-z-last-cache-clean';
const CACHE_CLEAN_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_SYNC_GAP_MS = 20_000;

let lastSyncAt = 0;
let syncing = null;

function storage() {
  try { return window.localStorage; } catch { return null; }
}

export function getInboxRetentionDays() {
  return normalizeRetentionDays(storage()?.getItem(RETENTION_KEY) ?? DEFAULT_INBOX_RETENTION_DAYS);
}

export function setInboxRetentionDays(days) {
  const value = normalizeRetentionDays(days);
  try { storage()?.setItem(RETENTION_KEY, String(value)); } catch {}
  runHousekeeping().catch(() => {});
  return value;
}

export async function listInboxMessages() {
  const items = await getAllRecords(STORE).catch(() => []);
  return items.sort((a, b) => a.sentAt - b.sentAt);
}

export async function countInboxMessages() {
  return withStores(STORE, 'readonly', (s) => idbRequest(s[STORE].count())).catch(() => 0);
}

async function saveMessages(items) {
  if (!items.length) return [];
  await withStores(STORE, 'readwrite', async (s) => {
    for (const item of items) s[STORE].put(item);
  });
  return items.map((item) => item.id);
}

/** Deletes messages older than the retention period; returns how many. */
export async function purgeExpiredMessages(now = Date.now()) {
  const cutoff = now - getInboxRetentionDays() * DAY_MS;
  return withStores(STORE, 'readwrite', (s) => new Promise((resolve, reject) => {
    let removed = 0;
    const request = s[STORE].index('sentAt').openCursor(IDBKeyRange.upperBound(cutoff, true));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(removed);
      cursor.delete();
      removed += 1;
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  })).catch(() => 0);
}

export async function clearInboxMessages() {
  await withStores(STORE, 'readwrite', (s) => idbRequest(s[STORE].clear())).catch(() => {});
}

/** Expired messages out; leftover speech cache out once a week. */
export async function runHousekeeping(now = Date.now()) {
  const removed = await purgeExpiredMessages(now);
  const last = Number(storage()?.getItem(LAST_CACHE_CLEAN_KEY) || 0);
  if (now - last > CACHE_CLEAN_EVERY_MS) {
    await clearSpeechCache().catch(() => {});
    try { storage()?.setItem(LAST_CACHE_CLEAN_KEY, String(now)); } catch {}
  }
  return { removed };
}

/**
 * Collects waiting messages from the node into this phone. Returns
 * { saved, linked }. Quietly does nothing when offline or not linked.
 */
export async function syncInbox(getAccessToken, { force = false } = {}) {
  if (syncing) return syncing;
  if (!force && Date.now() - lastSyncAt < MIN_SYNC_GAP_MS) return { saved: 0, linked: true, skipped: true };
  syncing = (async () => {
    const token = await getAccessToken();
    if (!token) return { saved: 0, linked: false };
    const headers = { Authorization: `Bearer ${token}` };
    const response = await fetch('/api/whatsapp/inbox', { headers, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    lastSyncAt = Date.now();
    const items = sanitizeInboxItems(data.items);
    const ids = await saveMessages(items);
    if (ids.length) {
      // Saved here first, then the node may forget them.
      await fetch('/api/whatsapp/inbox', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      }).catch(() => {});
    }
    await runHousekeeping();
    return { saved: ids.length, linked: data.linked !== false };
  })().catch(() => ({ saved: 0, linked: true, failed: true })).finally(() => { syncing = null; });
  return syncing;
}

/** For a question about the user's messages: fresh sync, then the context to attach. */
export async function inboxContextFor(message, getAccessToken) {
  if (!isInboxQuestion(message)) return undefined;
  await syncInbox(getAccessToken, { force: true });
  return buildInboxContext(await listInboxMessages());
}
