'use client';

/**
 * Hidden promises memory on this phone (owner request 2026-10-22). No screen
 * shows it. Candidates from WhatsApp wait in a small local queue; at most every
 * 20 minutes they go to /api/commitments/extract (the server keeps nothing) and
 * the notes come back here, each expiring on its own (3 days after its due
 * time, or 10 days when it has none). Read only when the user asks.
 */
import { getAllRecords, idbRequest, withStores } from './idb';
import { LOCAL_DATA_STORES } from './local-data';
import { commitmentLines, extractionLines, isExpired, MAX_COMMITMENTS, MAX_EXTRACTION_LINES } from './commitments';

const STORE = LOCAL_DATA_STORES.commitments;
const QUEUE_KEY = 'smartz-commitment-queue';
const LAST_RUN_KEY = 'smartz-commitment-last-run';
const MIN_GAP_MS = 20 * 60 * 1000;
const MAX_QUEUE = 150;
let running = null;

function storage() {
  try { return window.localStorage; } catch { return null; }
}

function readQueue() {
  try {
    const value = JSON.parse(storage()?.getItem(QUEUE_KEY) || '[]');
    return Array.isArray(value) ? value.filter((line) => typeof line === 'string') : [];
  } catch {
    return [];
  }
}

function writeQueue(lines) {
  try {
    if (lines.length) storage()?.setItem(QUEUE_KEY, JSON.stringify(lines.slice(-MAX_QUEUE)));
    else storage()?.removeItem(QUEUE_KEY);
  } catch {
    // Storage full or blocked: the next sync tries again.
  }
}

/** New WhatsApp items (incoming and the user's own): only lines that sound like a promise are queued. */
export function queueCommitmentCandidates(items) {
  const lines = extractionLines(items);
  if (lines.length) writeQueue([...readQueue(), ...lines]);
}

export async function purgeExpiredCommitments(now = Date.now()) {
  const records = await getAllRecords(STORE).catch(() => []);
  const expired = records.filter((record) => isExpired(record, now));
  if (!expired.length) return 0;
  await withStores(STORE, 'readwrite', async (s) => { for (const record of expired) s[STORE].delete(record.id); });
  return expired.length;
}

async function liveRecords(now = Date.now()) {
  const records = await getAllRecords(STORE).catch(() => []);
  return records.filter((record) => !isExpired(record, now));
}

/** Sends the queue for extraction (throttled unless forced) and stores what comes back. */
export async function processCommitments(getAccessToken, { force = false } = {}) {
  if (running) return running;
  const last = Number(storage()?.getItem(LAST_RUN_KEY) || 0);
  if (!force && Date.now() - last < MIN_GAP_MS) return 0;
  const queue = readQueue();
  if (!queue.length) return 0;
  running = (async () => {
    const token = await getAccessToken();
    if (!token) return 0;
    const batch = queue.slice(-MAX_EXTRACTION_LINES);
    const response = await fetch('/api/commitments/extract', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: batch }),
      cache: 'no-store',
    });
    try { storage()?.setItem(LAST_RUN_KEY, String(Date.now())); } catch {}
    if (!response.ok) return 0; // the queue stays for the next attempt
    const data = await response.json().catch(() => ({}));
    const records = Array.isArray(data.items) ? data.items : [];
    const existing = await liveRecords();
    const keep = new Map(existing.map((record) => [record.id, record]));
    for (const record of records) keep.set(record.id, { ...keep.get(record.id), ...record });
    const all = [...keep.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_COMMITMENTS);
    await withStores(STORE, 'readwrite', async (s) => {
      await idbRequest(s[STORE].clear());
      for (const record of all) s[STORE].put(record);
    });
    writeQueue([]);
    return records.length;
  })().catch(() => 0).finally(() => { running = null; });
  return running;
}

/** For «وش وعدت؟»: fresh extraction first, then every live note. */
export async function commitmentsForQuestion(getAccessToken) {
  await processCommitments(getAccessToken, { force: true }).catch(() => 0);
  return commitmentLines(await liveRecords());
}

/** For the day summary: notes due by the end of the period. */
export async function dueCommitmentLines(dueBy) {
  return commitmentLines(await liveRecords(), { dueBy });
}
