/**
 * One device per account (owner decision, 2026-10-16).
 *
 * Each install makes a random id (not a hardware id, nothing about the phone)
 * and sends it with every API call in the X-Smartz-Device header. The first
 * call binds the account to that id; any other id is refused until the admin
 * clears the binding from the admin panel. No dependencies, so it is testable.
 */

export const DEVICE_HEADER = 'x-smartz-device';
export const DEVICE_STORAGE_KEY = 'smartz-device-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidDeviceId(value) {
  return typeof value === 'string' && UUID.test(value);
}

export function readDeviceHeader(request) {
  const value = request?.headers?.get?.(DEVICE_HEADER) || '';
  return value.trim().toLowerCase();
}

/**
 * What the server does with a request, given the stored binding and the header.
 * 'ok'     : this device is the bound one.
 * 'bind'   : nothing bound yet; bind this device (atomically, in the database).
 * 'missing': the client sent no valid id (an old page still open): ask for a reload.
 */
export function decideDevice(boundDeviceId, headerDeviceId) {
  if (!isValidDeviceId(headerDeviceId)) return 'missing';
  if (boundDeviceId && String(boundDeviceId).toLowerCase() === headerDeviceId.toLowerCase()) return 'ok';
  return 'bind'; // also when another id is bound: the database answers DEVICE_MISMATCH
}

export const DEVICE_MESSAGES = {
  DEVICE_REQUIRED: 'حدّث الصفحة أو أعد فتح التطبيق ثم حاول مرة أخرى.',
  DEVICE_MISMATCH: 'هذا الحساب مفعّل على جهاز آخر. إن غيّرت هاتفك فتواصل مع الإدارة لنقل الحساب.',
  SUSPENDED: 'هذا الحساب موقوف. تواصل مع الإدارة.',
  NOT_REGISTERED: 'لا يوجد سجل عميل لهذا الحساب.',
  UNAVAILABLE: 'تعذر التحقق من الجهاز. أعد المحاولة.',
};

/** Client side: this install's id, made once and kept across customer changes on the same phone. */
export function getDeviceId(storage = globalThis.localStorage) {
  try {
    const stored = storage?.getItem(DEVICE_STORAGE_KEY);
    if (isValidDeviceId(stored)) return stored.toLowerCase();
    const fresh = globalThis.crypto.randomUUID();
    storage?.setItem(DEVICE_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}

/**
 * Client side: adds the device header to every same-origin /api/ call, so no
 * call site has to remember it. Safe to call more than once.
 */
export function installDeviceHeader(target = globalThis) {
  if (!target?.fetch || target.fetch.__smartzDevice) return;
  const originalFetch = target.fetch.bind(target);
  const wrapped = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    let sameOriginApi = url.startsWith('/api/');
    if (!sameOriginApi && target.location?.origin) {
      try {
        const parsed = new URL(url, target.location.origin);
        sameOriginApi = parsed.origin === target.location.origin && parsed.pathname.startsWith('/api/');
      } catch {}
    }
    if (!sameOriginApi) return originalFetch(input, init);
    const deviceId = getDeviceId(target.localStorage);
    if (!deviceId) return originalFetch(input, init);
    const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined));
    headers.set(DEVICE_HEADER, deviceId);
    return originalFetch(input, { ...init, headers });
  };
  wrapped.__smartzDevice = true;
  target.fetch = wrapped;
}
