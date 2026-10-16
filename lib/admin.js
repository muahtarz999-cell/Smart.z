/**
 * Admin panel rules (owner decision, 2026-10-16). Pure functions, no dependencies, so they are testable.
 *
 * Who is an admin: the e-mails in ADMIN_EMAILS (comma separated), set as a Cloudflare variable.
 * There is no admin column in the database: a stolen customer session can never grant itself admin.
 */

export const ADMIN_ACTIONS = Object.freeze([
  'create',
  'suspend',
  'activate',
  'reset_device',
  'set_password',
  'disconnect_whatsapp',
  'delete',
]);

// The admin must not lock themselves out from the panel itself.
export const SELF_FORBIDDEN_ACTIONS = Object.freeze(['suspend', 'delete']);

export const MIN_PASSWORD_LENGTH = 8;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function parseAdminEmails(value) {
  return String(value || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email, configured = process.env.ADMIN_EMAILS) {
  if (!email) return false;
  return parseAdminEmails(configured).includes(String(email).trim().toLowerCase());
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function validateEmail(value) {
  const email = normalizeEmail(value);
  return EMAIL.test(email) && email.length <= 254 ? email : null;
}

export function validatePassword(value) {
  if (typeof value !== 'string') return 'كلمة المرور مطلوبة.';
  if (value.length < MIN_PASSWORD_LENGTH) return `كلمة المرور ${MIN_PASSWORD_LENGTH} أحرف على الأقل.`;
  if (value.length > 72) return 'كلمة المرور أطول من المسموح (72 حرفاً).';
  if (/^\s|\s$/.test(value)) return 'لا تبدأ كلمة المرور أو تنتهي بمسافة.';
  return null;
}

/** Checks one POST body. Returns { ok, action, userId?, email?, password? } or { ok:false, message }. */
export function validateAdminRequest(body, adminUserId) {
  const action = body?.action;
  if (!ADMIN_ACTIONS.includes(action)) return { ok: false, message: 'إجراء غير معروف.' };

  if (action === 'create') {
    const email = validateEmail(body.email);
    if (!email) return { ok: false, message: 'البريد غير صالح.' };
    const passwordError = validatePassword(body.password);
    if (passwordError) return { ok: false, message: passwordError };
    return { ok: true, action, email, password: body.password };
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return { ok: false, message: 'معرّف العميل غير صالح.' };
  if (userId === adminUserId && SELF_FORBIDDEN_ACTIONS.includes(action)) {
    return { ok: false, message: 'لا يمكنك إيقاف حسابك أو حذفه من اللوحة.' };
  }
  if (action === 'set_password') {
    const passwordError = validatePassword(body.password);
    if (passwordError) return { ok: false, message: passwordError };
    return { ok: true, action, userId, password: body.password };
  }
  return { ok: true, action, userId };
}

/** One row of the customers table, merged from Auth, the registry and the WhatsApp node table. */
export function mergeCustomerRows(users = [], registry = [], nodes = [], adminUserId = null) {
  const registryById = new Map(registry.map((row) => [row.user_id, row]));
  const nodeById = new Map(nodes.map((row) => [row.user_id, row]));
  return users
    .map((user) => {
      const record = registryById.get(user.id) || null;
      const node = nodeById.get(user.id) || null;
      const bannedUntil = user.banned_until ? Date.parse(user.banned_until) : 0;
      return {
        id: user.id,
        email: user.email || '',
        createdAt: user.created_at || null,
        lastSignInAt: user.last_sign_in_at || null,
        registered: Boolean(record),
        active: Boolean(record) && record.is_active !== false && !(bannedUntil > Date.now()),
        deviceBound: Boolean(record?.device_id),
        deviceBoundAt: record?.device_bound_at || null,
        whatsappNode: node ? node.node_id : null,
        whatsappStatus: node ? node.status : null,
        isSelf: user.id === adminUserId,
      };
    })
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

/** A strong password the admin can copy to the customer: no look-alike characters. */
export function generatePassword(length = 12, random = (n) => globalThis.crypto.getRandomValues(new Uint32Array(n))) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(random(length), (value) => alphabet[value % alphabet.length]).join('');
}

export const ADMIN_MESSAGES = {
  NOT_ADMIN: 'هذا الحساب ليس حساب إدارة.',
  NOT_CONFIGURED: 'لوحة الإدارة غير مضبوطة: أضف ADMIN_EMAILS وSUPABASE_SERVICE_ROLE_KEY في Cloudflare.',
  EMAIL_EXISTS: 'هذا البريد مسجّل مسبقاً.',
  FAILED: 'تعذر تنفيذ الإجراء. أعد المحاولة.',
};
