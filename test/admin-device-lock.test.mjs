import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideDevice,
  DEVICE_HEADER,
  DEVICE_STORAGE_KEY,
  getDeviceId,
  installDeviceHeader,
  isValidDeviceId,
  readDeviceHeader,
} from '../lib/device-lock.js';
import {
  generatePassword,
  isAdminEmail,
  mergeCustomerRows,
  parseAdminEmails,
  validateAdminRequest,
} from '../lib/admin.js';

const A = '0b6e3c2a-7f1d-4c55-9a3e-1d2c3b4a5f60';
const B = '9d1f2e3a-4b5c-4d6e-8f70-819a2b3c4d5e';
const ADMIN = '11111111-2222-4333-8444-555555555555';

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) };
}

test('device ids are UUIDs and the header is read in lower case', () => {
  assert.equal(isValidDeviceId(A), true);
  assert.equal(isValidDeviceId('not-an-id'), false);
  assert.equal(isValidDeviceId(''), false);
  const request = { headers: new Headers({ [DEVICE_HEADER]: A.toUpperCase() }) };
  assert.equal(readDeviceHeader(request), A);
});

test('the bound device passes, a first device binds, any other device goes to the database check', () => {
  assert.equal(decideDevice(A, A), 'ok');
  assert.equal(decideDevice(A.toUpperCase(), A), 'ok');
  assert.equal(decideDevice(null, A), 'bind');
  assert.equal(decideDevice(A, B), 'bind'); // the database answers DEVICE_MISMATCH
  assert.equal(decideDevice(A, ''), 'missing');
  assert.equal(decideDevice(null, 'junk'), 'missing');
});

test('an install keeps one id across calls', () => {
  const storage = memoryStorage();
  const first = getDeviceId(storage);
  assert.equal(isValidDeviceId(first), true);
  assert.equal(getDeviceId(storage), first);
  assert.equal(storage.getItem(DEVICE_STORAGE_KEY), first);
});

test('the fetch wrapper adds the header to same-origin /api/ calls only', async () => {
  const seen = [];
  const target = {
    location: { origin: 'https://smart-z.pages.dev' },
    localStorage: memoryStorage(),
    fetch: async (input, init = {}) => { seen.push({ input, headers: new Headers(init.headers) }); return 'done'; },
  };
  installDeviceHeader(target);
  installDeviceHeader(target); // idempotent
  await target.fetch('/api/assistant', { headers: { Authorization: 'Bearer t' } });
  await target.fetch('https://smart-z.pages.dev/api/speech');
  await target.fetch('https://api.groq.com/openai/v1/chat');
  await target.fetch('/manifest.json');
  const id = target.localStorage.getItem(DEVICE_STORAGE_KEY);
  assert.equal(seen[0].headers.get(DEVICE_HEADER), id);
  assert.equal(seen[0].headers.get('authorization'), 'Bearer t');
  assert.equal(seen[1].headers.get(DEVICE_HEADER), id);
  assert.equal(seen[2].headers.get(DEVICE_HEADER), null);
  assert.equal(seen[3].headers.get(DEVICE_HEADER), null);
});

test('admin e-mails come from a comma list, case-insensitive', () => {
  assert.deepEqual(parseAdminEmails(' Owner@Mail.com , ,second@x.io'), ['owner@mail.com', 'second@x.io']);
  assert.equal(isAdminEmail('OWNER@mail.com', 'owner@mail.com'), true);
  assert.equal(isAdminEmail('someone@mail.com', 'owner@mail.com'), false);
  assert.equal(isAdminEmail('owner@mail.com', ''), false);
  assert.equal(isAdminEmail('', 'owner@mail.com'), false);
});

test('creating a customer needs a valid e-mail and an 8+ character password', () => {
  assert.equal(validateAdminRequest({ action: 'create', email: 'bad', password: 'longenough' }, ADMIN).ok, false);
  assert.equal(validateAdminRequest({ action: 'create', email: 'c@x.io', password: 'short' }, ADMIN).ok, false);
  const ok = validateAdminRequest({ action: 'create', email: ' C@X.io ', password: 'longenough' }, ADMIN);
  assert.equal(ok.ok, true);
  assert.equal(ok.email, 'c@x.io');
});

test('the admin cannot suspend or delete themselves, but can reset their own device', () => {
  assert.equal(validateAdminRequest({ action: 'delete', userId: ADMIN }, ADMIN).ok, false);
  assert.equal(validateAdminRequest({ action: 'suspend', userId: ADMIN }, ADMIN).ok, false);
  assert.equal(validateAdminRequest({ action: 'reset_device', userId: ADMIN }, ADMIN).ok, true);
  assert.equal(validateAdminRequest({ action: 'delete', userId: A }, ADMIN).ok, true);
  assert.equal(validateAdminRequest({ action: 'drop_tables', userId: A }, ADMIN).ok, false);
  assert.equal(validateAdminRequest({ action: 'delete', userId: 'x' }, ADMIN).ok, false);
  assert.equal(validateAdminRequest({ action: 'set_password', userId: A, password: 'short' }, ADMIN).ok, false);
});

test('the customer list merges account, registry and WhatsApp node, newest first', () => {
  const rows = mergeCustomerRows(
    [
      { id: A, email: 'old@x.io', created_at: '2026-10-01T00:00:00Z' },
      { id: B, email: 'new@x.io', created_at: '2026-10-10T00:00:00Z', banned_until: '2999-01-01T00:00:00Z' },
      { id: ADMIN, email: 'owner@x.io', created_at: '2026-09-01T00:00:00Z' },
    ],
    [
      { user_id: A, is_active: true, device_id: B, device_bound_at: '2026-10-02T00:00:00Z' },
      { user_id: B, is_active: true, device_id: null },
      { user_id: ADMIN, is_active: true },
    ],
    [{ user_id: A, node_id: 2, status: 'connected' }],
    ADMIN,
  );
  assert.deepEqual(rows.map((row) => row.email), ['new@x.io', 'old@x.io', 'owner@x.io']);
  assert.equal(rows[0].active, false); // banned counts as suspended
  assert.equal(rows[1].deviceBound, true);
  assert.equal(rows[1].whatsappNode, 2);
  assert.equal(rows[2].isSelf, true);
});

test('generated passwords have no look-alike characters', () => {
  const password = generatePassword(40);
  assert.equal(password.length, 40);
  assert.doesNotMatch(password, /[0O1lI]/);
});
