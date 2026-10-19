export const COMPUTER_PAIRING_KEY_DB = 'smartz-computer-pairing';
const KEY_STORE = 'keys';

export function pairingProofMessage(sessionId, challenge) {
  return `smartz-computer-pairing:v1:${sessionId}:${challenge}`;
}

export function parseComputerPairingQr(value, currentOrigin) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('رمز QR لا يحتوي على بيانات اقتران صالحة.');
  }

  const allowedKeys = ['version', 'origin', 'sessionId', 'token'];
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some((key) => !allowedKeys.includes(key)) ||
    parsed.version !== 1 ||
    parsed.origin !== currentOrigin ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.sessionId || '') ||
    !/^[A-Za-z0-9_-]{43}$/.test(parsed.token || '')
  ) {
    throw new Error('رمز الاقتران غير صالح أو صادر من موقع مختلف.');
  }

  return parsed;
}

export async function createComputerKeyPair(subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('المتصفح لا يدعم التشفير الآمن المطلوب.');
  const generated = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const [publicDer, privateDer] = await Promise.all([
    subtle.exportKey('spki', generated.publicKey),
    subtle.exportKey('pkcs8', generated.privateKey),
  ]);

  let privateKey;
  try {
    privateKey = await subtle.importKey(
      'pkcs8',
      privateDer,
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
  } finally {
    new Uint8Array(privateDer).fill(0);
  }

  return {
    publicKey: toBase64Url(publicDer),
    privateKey,
  };
}

export async function signComputerPairingChallenge(privateKey, sessionId, challenge, subtle = globalThis.crypto?.subtle) {
  const signature = await subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    new TextEncoder().encode(pairingProofMessage(sessionId, challenge)),
  );
  return toBase64Url(signature);
}

export async function saveComputerPrivateKey(id, privateKey, indexedDB = globalThis.indexedDB) {
  const db = await openKeyDatabase(indexedDB);
  try {
    await transactionRequest(db, (store) => store.put(privateKey, id));
  } finally {
    db.close();
  }
}

export async function getComputerPrivateKey(id, indexedDB = globalThis.indexedDB) {
  const db = await openKeyDatabase(indexedDB);
  try {
    const transaction = db.transaction(KEY_STORE, 'readonly');
    const key = await requestResult(transaction.objectStore(KEY_STORE).get(id));
    await transactionDone(transaction);
    return key || null;
  } finally {
    db.close();
  }
}

export async function moveComputerPrivateKey(fromId, toId, indexedDB = globalThis.indexedDB) {
  const db = await openKeyDatabase(indexedDB);
  try {
    const transaction = db.transaction(KEY_STORE, 'readwrite');
    const store = transaction.objectStore(KEY_STORE);
    const done = transactionDone(transaction);
    const request = store.get(fromId);
    request.onsuccess = () => {
      if (!request.result) {
        transaction.abort();
        return;
      }
      store.put(request.result, toId);
      store.delete(fromId);
    };
    await done;
  } finally {
    db.close();
  }
}

export async function deleteComputerPrivateKey(id, indexedDB = globalThis.indexedDB) {
  const db = await openKeyDatabase(indexedDB);
  try {
    await transactionRequest(db, (store) => store.delete(id));
  } finally {
    db.close();
  }
}

function toBase64Url(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function openKeyDatabase(indexedDB) {
  if (!indexedDB) return Promise.reject(new Error('يلزم متصفح يدعم التخزين الآمن للمفتاح الخاص.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(COMPUTER_PAIRING_KEY_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEY_STORE)) {
        request.result.createObjectStore(KEY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('تعذر فتح مخزن مفاتيح الكمبيوتر الآمن.'));
    request.onblocked = () => reject(new Error('مخزن مفاتيح الكمبيوتر مشغول في نافذة أخرى.'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('تعذر قراءة مفتاح الكمبيوتر.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('تعذر حفظ مفتاح الكمبيوتر.'));
    transaction.onabort = () => reject(transaction.error || new Error('أُلغي حفظ مفتاح الكمبيوتر.'));
  });
}

async function transactionRequest(db, callback) {
  const transaction = db.transaction(KEY_STORE, 'readwrite');
  const result = callback(transaction.objectStore(KEY_STORE));
  await transactionDone(transaction);
  return result;
}
