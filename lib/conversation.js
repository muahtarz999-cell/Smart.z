'use client';

import { openLocalDatabase } from './local-data';

const STORE = 'messages';
const WINDOW_SIZE = 20;

function transactionCompletion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Conversation storage failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Conversation storage was aborted.'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Conversation storage request failed.'));
  });
}

async function evictOldMessages(database) {
  const transaction = database.transaction(STORE, 'readwrite');
  const done = transactionCompletion(transaction);
  const store = transaction.objectStore(STORE);
  const excess = await requestResult(store.count()) - WINDOW_SIZE;
  if (excess > 0) {
    const cursorRequest = store.index('created_at').openCursor();
    let deleted = 0;
    await new Promise((resolve, reject) => {
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || deleted >= excess) {
          resolve();
          return;
        }
        cursor.delete();
        deleted++;
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error || new Error('Could not trim conversation history.'));
    });
  }
  await done;
}

export async function addMessage(role, content, meta = {}) {
  const database = await openLocalDatabase();
  const transaction = database.transaction(STORE, 'readwrite');
  const done = transactionCompletion(transaction);
  const id = await requestResult(transaction.objectStore(STORE).add({
    role,
    content,
    created_at: Date.now(),
    meta,
  }));
  await done;
  await evictOldMessages(database);
  return id;
}

export async function getRecentMessages(limit = WINDOW_SIZE) {
  const database = await openLocalDatabase();
  const transaction = database.transaction(STORE, 'readonly');
  const done = transactionCompletion(transaction);
  const results = [];
  const cursorRequest = transaction.objectStore(STORE).index('created_at').openCursor(null, 'prev');
  await new Promise((resolve, reject) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error || new Error('Could not read conversation history.'));
  });
  await done;
  return results.reverse();
}

export async function clearAllMessages() {
  const database = await openLocalDatabase();
  const transaction = database.transaction(STORE, 'readwrite');
  const done = transactionCompletion(transaction);
  transaction.objectStore(STORE).clear();
  await done;
}

export async function getLastAssistantMessage() {
  const [latestMessage] = await getRecentMessages(1);
  return latestMessage?.role === 'assistant' ? latestMessage : null;
}
