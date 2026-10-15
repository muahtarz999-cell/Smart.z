'use client';

/** The local file library ("ملفاتي"). Everything stays in this device's IndexedDB. */

import { getAllByIndex, getAllRecords, getRecord, idbRequest, putRecord, withStores } from './idb';
import { searchChunks } from './local-search';

const CONSENT_KEY = 'smartz-file-analysis-consent';
export const MAX_CONTEXT_CHARACTERS = 12_000;

export async function saveProcessedFile({ record, chunks }) {
  await withStores(['files', 'fileChunks'], 'readwrite', async (stores) => {
    stores.files.put(record);
    for (const chunk of chunks) stores.fileChunks.put(chunk);
  });
  return record;
}

export async function listFiles() {
  return (await getAllRecords('files')).sort((a, b) => b.createdAt - a.createdAt);
}

export const getFile = (id) => getRecord('files', id);

export async function latestFile() {
  return (await listFiles())[0] || null;
}

export async function renameFile(id, name) {
  const file = await getFile(id);
  if (!file) return null;
  return putRecord('files', { ...file, name: String(name).trim().slice(0, 120) || file.name, updatedAt: Date.now() });
}

export async function deleteFile(id) {
  const chunks = await getAllByIndex('fileChunks', 'fileId', id);
  await withStores(['files', 'fileChunks', 'studySets'], 'readwrite', async (stores) => {
    stores.files.delete(id);
    for (const chunk of chunks) stores.fileChunks.delete(chunk.id);
    const sets = await idbRequest(stores.studySets.index('fileId').getAll(id));
    for (const set of sets) stores.studySets.delete(set.id);
  });
}

export async function getFileChunks(fileId) {
  return (await getAllByIndex('fileChunks', 'fileId', fileId)).sort((a, b) => a.page - b.page || a.index - b.index);
}

/** Chunks inside an optional page range, in reading order. */
export async function getChunksInRange(fileId, fromPage, toPage) {
  const chunks = await getFileChunks(fileId);
  return chunks.filter((c) => (!fromPage || c.page >= fromPage) && (!toPage || c.page <= toPage));
}

/**
 * The passages to send with a question: the best BM25 matches, or the start
 * of the file when the question is general ("لخّص الملف"). Never more than 12k chars.
 */
export async function findRelevantPassages(fileId, question, maxCharacters = MAX_CONTEXT_CHARACTERS) {
  const chunks = await getFileChunks(fileId);
  const ranked = searchChunks(chunks, question, { limit: 15 });
  const pool = ranked.length >= 2 ? ranked : chunks;
  const picked = [];
  let total = 0;
  for (const chunk of pool) {
    if (total + chunk.text.length > maxCharacters) break;
    picked.push(chunk);
    total += chunk.text.length;
  }
  return picked.sort((a, b) => a.page - b.page || a.index - b.index).map(({ page, text }) => ({ page, text }));
}

export async function storageUsage() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return estimate ? { used: estimate.usage || 0, quota: estimate.quota || 0 } : null;
  } catch {
    return null;
  }
}

export function hasFileAnalysisConsent() {
  try { return localStorage.getItem(CONSENT_KEY) === 'granted'; } catch { return false; }
}

export function setFileAnalysisConsent(granted) {
  try {
    if (granted) localStorage.setItem(CONSENT_KEY, 'granted');
    else localStorage.removeItem(CONSENT_KEY);
  } catch {}
}

export function formatBytes(bytes) {
  if (!bytes) return '0 ب';
  const units = ['ب', 'ك.ب', 'م.ب', 'ج.ب'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
}

