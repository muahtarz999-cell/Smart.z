import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createPairingSecret,
  hashPairingSecret,
  pairingProofMessage,
  validateComputerPublicKey,
  verifyComputerPairingProof,
} from '../lib/computer-pairing-crypto.js';
import { parseComputerPairingQr } from '../lib/computer-pairing-client.js';

const migration = await readFile(
  new URL('../supabase/migrations/202610180006_computer_pairing_qr.sql', import.meta.url),
  'utf8',
);
const creationRoute = await readFile(
  new URL('../app/api/computer/pairing/sessions/route.js', import.meta.url),
  'utf8',
);
const approvalRoute = await readFile(
  new URL('../app/api/computer/pairing/sessions/[sessionId]/approve/route.js', import.meta.url),
  'utf8',
);
const completionRoute = await readFile(
  new URL('../app/api/computer/pairing/sessions/[sessionId]/complete/route.js', import.meta.url),
  'utf8',
);
const cancellationRoute = await readFile(
  new URL('../app/api/computer/pairing/sessions/[sessionId]/cancel/route.js', import.meta.url),
  'utf8',
);
const desktop = await readFile(
  new URL('../components/ComputerPairingDesktop.jsx', import.meta.url),
  'utf8',
);
const phone = await readFile(
  new URL('../components/ComputerPairingPhone.jsx', import.meta.url),
  'utf8',
);

function functionBody(name) {
  const start = migration.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `function ${name} is declared`);
  const end = migration.indexOf('$function$;', start);
  assert.notEqual(end, -1, `function ${name} closes`);
  return migration.slice(start, end);
}

test('pairing secrets are random bearer values whose stored representation is only a SHA-256 digest', () => {
  const first = createPairingSecret();
  const second = createPairingSecret();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.match(hashPairingSecret(first), /^[0-9a-f]{64}$/);
  assert.notEqual(hashPairingSecret(first), first);
  assert.match(migration, /token_hash text not null unique/);
  assert.doesNotMatch(migration, /\btoken\s+text\b/i);
  assert.match(creationRoute, /token:\s*secret/);
  assert.match(creationRoute, /p_token_hash:\s*hashPairingSecret\(secret\)/);
});

test('QR payload is bound to this origin, UUID session, version, and exact expected fields', () => {
  const payload = JSON.stringify({
    version: 1,
    origin: 'https://smartz.example',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    token: createPairingSecret(),
  });
  assert.equal(parseComputerPairingQr(payload, 'https://smartz.example').version, 1);
  assert.throws(() => parseComputerPairingQr(payload, 'https://attacker.example'));
  assert.throws(() => parseComputerPairingQr(`${payload.slice(0, -1)},"extra":true}`, 'https://smartz.example'));
  assert.throws(() => parseComputerPairingQr('not-json', 'https://smartz.example'));
});

test('Ed25519 proof binds the private key to the exact session challenge', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const encodedKey = publicKeyDer.toString('base64url');
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const challenge = createPairingSecret();
  const signature = sign(
    null,
    Buffer.from(pairingProofMessage(sessionId, challenge)),
    privateKey,
  ).toString('base64url');

  assert.equal(validateComputerPublicKey(encodedKey), true);
  assert.equal(verifyComputerPairingProof(encodedKey, sessionId, challenge, signature), true);
  assert.equal(verifyComputerPairingProof(encodedKey, sessionId, createPairingSecret(), signature), false);
  assert.equal(verifyComputerPairingProof(encodedKey, sessionId, challenge, `${signature.slice(0, -1)}!`), false);
  assert.equal(validateComputerPublicKey(`${encodedKey}=`), false);
});

test('sessions expire after five minutes, are single-decision, and complete only after explicit approval', () => {
  const create = functionBody('create_computer_pairing_session');
  const status = functionBody('get_computer_pairing_session_status');
  const decision = functionBody('decide_computer_pairing_session');
  const complete = functionBody('complete_computer_pairing_session');
  assert.match(create, /v_now \+ interval '5 minutes'/);
  assert.match(status, /for update/);
  assert.match(status, /v_session\.expires_at <= v_now/);
  assert.match(status, /set status = 'expired'/);
  assert.match(decision, /customer\.user_id = p_user_id/);
  assert.match(decision, /customer\.allow_computer_pairing/);
  assert.match(decision, /for update/);
  assert.match(decision, /status not in \('pending', 'approved'\)/);
  assert.match(decision, /replacement_required/);
  assert.match(complete, /v_session\.status <> 'approved'/);
  assert.match(complete, /v_session\.expires_at <= v_now/);
  assert.match(complete, /status = 'completed', device_id = v_device\.id/);
  assert.match(complete, /return jsonb_build_object\('outcome', 'paired', 'deviceId', v_session\.device_id\)/);
  assert.match(migration, /unique index computer_devices_one_active_per_user_uidx[\s\S]*?where status = 'active'/);
});

test('replacement revokes the prior device and cancels its unfinished tasks atomically', () => {
  const complete = functionBody('complete_computer_pairing_session');
  assert.match(complete, /set status = 'revoked', revoked_at = v_now/);
  assert.match(complete, /set status = 'cancelled', updated_at = v_now/);
  assert.match(complete, /update public\.computer_task_approvals[\s\S]*?decision = 'expired'/);
  assert.match(complete, /insert into public\.computer_audit_logs/);
  assert.match(migration, /computer_pairing_sessions_device_owner_fk/);
  assert.match(migration, /foreign key \(user_id, device_id\)[\s\S]*?references public\.computer_devices\(user_id, id\)/);
});

test('all pairing RPCs are server-only and direct table access is revoked', () => {
  const procedures = [
    ['create_computer_pairing_session', 'text, text, text, text, text'],
    ['get_computer_pairing_session_status', 'uuid, text'],
    ['cancel_computer_pairing_session', 'uuid, text'],
    ['decide_computer_pairing_session', 'uuid, text, uuid, text, boolean'],
    ['complete_computer_pairing_session', 'uuid, text, boolean'],
  ];
  for (const [name, signature] of procedures) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}\\(${signature.replace(/[(),]/g, '\\$&')}\\)[\\s\\S]*?from public, anon, authenticated`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}\\(`));
  }
  assert.match(migration, /alter table public\.computer_pairing_sessions enable row level security/);
  assert.match(migration, /revoke all on public\.computer_pairing_sessions from public, anon, authenticated/);
});

test('approval uses the authenticated account identity and completion validates the signature before the atomic RPC', () => {
  assert.match(approvalRoute, /requireComputerAccess\(request\)/);
  assert.match(approvalRoute, /p_user_id:\s*context\.access\.user\.id/);
  assert.match(approvalRoute, /callComputerRpc\(context\.service, 'decide_computer_pairing_session'/);
  assert.match(completionRoute, /verifyComputerPairingProof\(/);
  assert.ok(completionRoute.indexOf('verifyComputerPairingProof(') < completionRoute.indexOf("'complete_computer_pairing_session'"));
  assert.match(completionRoute, /p_proof_verified:\s*true/);
  assert.match(cancellationRoute, /callComputerRpc\(service, 'cancel_computer_pairing_session'/);
  assert.match(desktop, /sessionStorage\.setItem\(SESSION_STORAGE_KEY/);
  assert.match(desktop, /moveComputerPrivateKey\(session\.sessionId, result\.deviceId\)/);
  assert.match(phone, /replaceExisting/);
  assert.match(phone, /أؤكد استبدال الكمبيوتر النشط/);
});
