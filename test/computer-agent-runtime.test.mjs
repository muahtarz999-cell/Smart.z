import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  computerRequestMessage,
  signComputerRequest,
  verifyComputerRequest,
} from '../lib/computer-device-auth.mjs';

const migration = await readFile(
  new URL('../supabase/migrations/202610180007_computer_agent_runtime.sql', import.meta.url),
  'utf8',
);
const deviceApi = await readFile(new URL('../lib/computer-device-api.js', import.meta.url), 'utf8');
const claimRoute = await readFile(
  new URL('../app/api/computer/devices/[deviceId]/tasks/claim/route.js', import.meta.url),
  'utf8',
);
const resultRoute = await readFile(
  new URL('../app/api/computer/devices/[deviceId]/tasks/[taskId]/result/route.js', import.meta.url),
  'utf8',
);
const cancelRoute = await readFile(
  new URL('../app/api/computer/tasks/[taskId]/cancel/route.js', import.meta.url),
  'utf8',
);
const agent = await readFile(new URL('../computer-agent/AgentForm.cs', import.meta.url), 'utf8');
const configuration = await readFile(new URL('../computer-agent/AgentConfiguration.cs', import.meta.url), 'utf8');

function signedFixture({ pathname = '/api/computer/devices/550e8400-e29b-41d4-a716-446655440000/tasks/claim' } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(24).toString('base64url');
  const body = Buffer.from('{}');
  const publicKeyEncoded = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const signature = signComputerRequest({
    privateKey,
    method: 'POST',
    pathname,
    timestamp,
    nonce,
    body,
  });
  return { publicKeyEncoded, privateKey, timestamp, nonce, body, signature, pathname };
}

test('computer request signatures bind method, API path, timestamp, nonce, and exact body', () => {
  const fixture = signedFixture();
  const fields = {
    publicKey: fixture.publicKeyEncoded,
    method: 'POST',
    pathname: fixture.pathname,
    timestamp: fixture.timestamp,
    nonce: fixture.nonce,
    signature: fixture.signature,
    body: fixture.body,
  };
  assert.equal(verifyComputerRequest(fields), true);
  assert.equal(verifyComputerRequest({ ...fields, body: Buffer.from('{"different":true}') }), false);
  assert.equal(verifyComputerRequest({ ...fields, method: 'GET' }), false);
  assert.equal(verifyComputerRequest({ ...fields, pathname: `${fixture.pathname}?device=other` }), false);
  assert.equal(verifyComputerRequest({ ...fields, nonce: 'short' }), false);
  assert.equal(verifyComputerRequest({ ...fields, timestamp: '1' }), false);
  assert.match(computerRequestMessage('post', '/api/computer/devices/a', '1', 'n', Buffer.alloc(0)), /^smartz-computer-request:v1\nPOST\n/);
});

test('server validates active devices, consumes single-use request nonces, and only exposes allowlisted task operations', () => {
  assert.match(deviceApi, /verifyComputerRequest/);
  assert.match(deviceApi, /consume_computer_device_nonce/);
  assert.match(deviceApi, /REQUEST_REPLAYED/);
  assert.match(claimRoute, /claim_computer_task/);
  assert.match(claimRoute, /authenticateComputerRequest/);
  assert.match(resultRoute, /report_computer_task_result/);
  assert.match(resultRoute, /p_device_id:\s*deviceId/);
  assert.match(cancelRoute, /p_user_id:\s*context\.access\.user\.id/);
  assert.match(migration, /primary key \(device_id, nonce\)/i);
  assert.match(migration, /on conflict \(device_id, nonce\) do nothing/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /task\.status = 'approved'/);
  assert.match(migration, /set status = 'running'/);
  assert.match(migration, /p_status not in \('succeeded', 'failed'\)/);
  assert.match(migration, /status not in \('queued', 'awaiting_approval', 'approved', 'running'\)/);
  assert.match(migration, /revoke all on function public\.claim_computer_task\(uuid\)[\s\S]*?from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.claim_computer_task\(uuid\) to service_role/i);
});

test('Windows client protects private key with current-user DPAPI and confines work to chosen folders', () => {
  assert.match(configuration, /ProtectedData\.Protect/);
  assert.match(configuration, /ProtectedData\.Unprotect/);
  assert.match(configuration, /DataProtectionScope\.CurrentUser/);
  assert.match(agent, /SignatureAlgorithm\.Ed25519\.Sign/);
  assert.match(agent, /_configuration\.AuthorizedRoots/);
  assert.match(agent, /EnsureNoReparsePoint/);
  assert.match(agent, /FileMode\.CreateNew/);
  assert.doesNotMatch(agent, /Process\.Start|cmd\.exe|powershell\.exe/i);
});
