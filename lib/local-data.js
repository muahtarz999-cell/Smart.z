const DATABASE_NAME = 'smart-assistant';
const DATABASE_VERSION = 2;
export const LOCAL_DATA_STORES = Object.freeze({
  messages: 'messages',
  memories: 'memories',
  notes: 'notes',
  tasks: 'tasks',
});

let databasePromise;

export function openLocalDatabase() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable in this browser.'));
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LOCAL_DATA_STORES.messages)) {
        const messages = database.createObjectStore(LOCAL_DATA_STORES.messages, {
          keyPath: 'id',
          autoIncrement: true,
        });
        messages.createIndex('created_at', 'created_at');
      }

      for (const storeName of [
        LOCAL_DATA_STORES.memories,
        LOCAL_DATA_STORES.notes,
        LOCAL_DATA_STORES.tasks,
      ]) {
        if (database.objectStoreNames.contains(storeName)) continue;
        const store = database.createObjectStore(storeName, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
        store.createIndex('createdAt', 'createdAt');
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error || new Error('Could not open local data storage.'));
    };
  });

  return databasePromise;
}

function transactionCompletion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Local data transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Local data transaction was aborted.'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Local data request failed.'));
  });
}

function getRecordStore(storeName) {
  if (![
    LOCAL_DATA_STORES.memories,
    LOCAL_DATA_STORES.notes,
    LOCAL_DATA_STORES.tasks,
  ].includes(storeName)) {
    throw new TypeError('Unsupported local record store.');
  }
  return storeName;
}

function makeRecordId() {
  return globalThis.crypto?.randomUUID?.()
    || `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function listLocalRecords(storeName) {
  const database = await openLocalDatabase();
  const transaction = database.transaction(getRecordStore(storeName), 'readonly');
  const done = transactionCompletion(transaction);
  const records = await requestResult(transaction.objectStore(storeName).getAll());
  await done;
  return records.sort((left, right) =>
    (right.updatedAt || right.createdAt || 0) - (left.updatedAt || left.createdAt || 0)
  );
}

export async function saveLocalRecord(storeName, record) {
  const targetStore = getRecordStore(storeName);
  if (!record || typeof record !== 'object') {
    throw new TypeError('A local record is required.');
  }
  const now = Date.now();
  const value = {
    ...record,
    id: typeof record.id === 'string' && record.id ? record.id : makeRecordId(),
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : now,
    updatedAt: now,
  };

  const database = await openLocalDatabase();
  const transaction = database.transaction(targetStore, 'readwrite');
  const done = transactionCompletion(transaction);
  await requestResult(transaction.objectStore(targetStore).put(value));
  await done;
  return value;
}

export async function deleteLocalRecord(storeName, recordId) {
  if (typeof recordId !== 'string' || !recordId) {
    throw new TypeError('A valid local record ID is required.');
  }
  const database = await openLocalDatabase();
  const transaction = database.transaction(getRecordStore(storeName), 'readwrite');
  const done = transactionCompletion(transaction);
  await requestResult(transaction.objectStore(storeName).delete(recordId));
  await done;
}

export async function clearAllLocalData() {
  const database = await openLocalDatabase();
  const storeNames = Object.values(LOCAL_DATA_STORES)
    .filter((storeName) => database.objectStoreNames.contains(storeName));
  const transaction = database.transaction(storeNames, 'readwrite');
  const done = transactionCompletion(transaction);
  for (const storeName of storeNames) transaction.objectStore(storeName).clear();
  await done;
}

export async function migrateLegacyMemories(storageKey) {
  if (typeof window === 'undefined') {
    throw new Error('Legacy memory migration requires a browser.');
  }
  const serialized = window.localStorage.getItem(storageKey);
  if (serialized === null) return false;

  const entries = JSON.parse(serialized);
  if (!Array.isArray(entries)) {
    throw new Error('Legacy memory data has an unsupported format.');
  }
  const records = entries.map((entry, index) => {
    if (typeof entry === 'string') {
      return { id: `memory-${index}`, text: entry };
    }
    if (entry && typeof entry.text === 'string') {
      return {
        id: String(entry.id ?? `memory-${index}`),
        text: entry.text,
        createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : undefined,
      };
    }
    throw new Error('A legacy memory entry has an unsupported format.');
  });

  const database = await openLocalDatabase();
  const transaction = database.transaction(LOCAL_DATA_STORES.memories, 'readwrite');
  const done = transactionCompletion(transaction);
  const store = transaction.objectStore(LOCAL_DATA_STORES.memories);
  for (const record of records) {
    const existing = await requestResult(store.get(record.id));
    if (existing === undefined) {
      await requestResult(store.add({
        ...record,
        createdAt: record.createdAt ?? Date.now(),
        updatedAt: record.createdAt ?? Date.now(),
      }));
    }
  }
  await done;
  window.localStorage.removeItem(storageKey);
  return true;
}
