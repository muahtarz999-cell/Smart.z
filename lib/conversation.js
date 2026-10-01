'use client';

/**
 * ذاكرة المحادثة المتسلسلة لكل مستخدم — IndexedDB
 *
 * - نافذة منزلقة: نحتفظ بآخر N رسالة فقط (افتراضيًا 20) كسياق نشط.
 * - محو تلقائي لما هو أقدم من النافذة → لا تضخّم في الذاكرة.
 * - التخزين محلي بالكامل على جهاز المستخدم (ملفات تعلّم خاصة به).
 */

const DB_NAME = 'smart-assistant';
const STORE = 'messages';
const WINDOW_SIZE = 20; // آخر 20 رسالة كسياق نشط

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('created_at', 'created_at');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** أضف رسالة جديدة + امحُ ما هو خارج النافذة تلقائيًا */
export async function addMessage(role, content, meta = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const addReq = store.add({
      role, // 'user' | 'assistant'
      content,
      created_at: Date.now(),
      meta,
    });
    addReq.onsuccess = async () => {
      // محو الأقدم خارج النافذة
      await evictOldMessages(db);
      resolve(addReq.result);
    };
    addReq.onerror = () => reject(addReq.error);
  });
}

/** استرجع آخر N رسالة كسياق (للتمرير للنموذج) */
export async function getRecentMessages(limit = WINDOW_SIZE) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const idx = store.index('created_at');
    const req = idx.openCursor(null, 'prev'); // الأحدث أولًا
    const results = [];
    req.onsuccess = () => {
      const cur = req.result;
      if (cur && results.length < limit) {
        results.push(cur.value);
        cur.continue();
      } else {
        // نُرجع بترتيب زمني تصاعدي
        results.reverse();
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/** امحُ كل الرسائل خارج النافذة (تنظيف تلقائي) */
async function evictOldMessages(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const total = countReq.result;
      const excess = total - WINDOW_SIZE;
      if (excess <= 0) {
        resolve();
        return;
      }
      // امحُ الأقدم excess رسالة
      const idx = store.index('created_at');
      const cursorReq = idx.openCursor(); // تصاعدي = الأقدم أولًا
      let deleted = 0;
      cursorReq.onsuccess = () => {
        const cur = cursorReq.result;
        if (cur && deleted < excess) {
          cur.delete();
          deleted++;
          cur.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    };
    countReq.onerror = () => reject(countReq.error);
  });
}

/** امحُ كل المحادثة (عند الطلب) */
export async function clearAllMessages() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** استرجع آخر رد من المساعد (للعرض عند إعادة فتح التطبيق) */
export async function getLastAssistantMessage() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const idx = store.index('created_at');
    const req = idx.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      if (cur && cur.value.role === 'assistant') {
        resolve(cur.value);
      } else {
        resolve(null);
      }
    };
    req.onerror = () => reject(req.error);
  });
}
