'use client';

/** Small promise helpers over the app's IndexedDB (see lib/local-data.js). */
import { openLocalDatabase } from './local-data';

export function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Local storage request failed.'));
  });
}

/** Runs `work(stores)` in one transaction and resolves with its return value after commit. */
export async function withStores(names, mode, work) {
  const database = await openLocalDatabase();
  const list = Array.isArray(names) ? names : [names];
  const tx = database.transaction(list, mode);
  const stores = Object.fromEntries(list.map((name) => [name, tx.objectStore(name)]));
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Local storage transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('Local storage transaction aborted.'));
  });
  const result = await work(stores);
  await done;
  return result;
}

export const getRecord = (store, id) => withStores(store, 'readonly', (s) => idbRequest(s[store].get(id)));
export const getAllRecords = (store) => withStores(store, 'readonly', (s) => idbRequest(s[store].getAll()));
export const getAllByIndex = (store, index, value) => withStores(store, 'readonly', (s) => idbRequest(s[store].index(index).getAll(value)));
export const putRecord = (store, record) => withStores(store, 'readwrite', (s) => idbRequest(s[store].put(record)).then(() => record));
export const deleteRecord = (store, id) => withStores(store, 'readwrite', (s) => idbRequest(s[store].delete(id)));

export function newId(prefix = 'id') {
  return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
