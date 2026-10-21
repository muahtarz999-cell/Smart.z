'use client';

import { deleteRecord, getAllRecords, newId, putRecord } from './idb';

export async function listLaws() { return (await getAllRecords('legal')).sort((a, b) => a.name.localeCompare(b.name, 'ar')); }
export async function saveLaw({ name, source, articles }) {
  const cleanName = String(name || '').trim().slice(0, 120);
  const existing = (await listLaws()).find((law) => law.name === cleanName);
  const now = Date.now();
  return putRecord('legal', { id: existing?.id || newId('law'), name: cleanName, source: String(source || '').trim().slice(0, 300), articles, importedAt: now, updatedAt: now });
}
export const deleteLaw = (id) => deleteRecord('legal', id);
export const importedDate = (law) => new Date(law.importedAt).toISOString().slice(0, 10);
