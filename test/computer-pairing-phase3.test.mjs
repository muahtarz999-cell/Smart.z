import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  computerAccessFailure,
  isComputerUuid,
  readComputerJson,
  validateComputerTask,
} from '../lib/computer-task-validation.mjs';

const migration = await readFile(
  new URL('../supabase/migrations/202610180005_computer_pairing_atomic_operations.sql', import.meta.url),
  'utf8',
);
const taskRoute = await readFile(new URL('../app/api/computer/tasks/route.js', import.meta.url), 'utf8');
const approvalRoute = await readFile(
  new URL('../app/api/computer/tasks/[taskId]/approval/route.js', import.meta.url),
  'utf8',
);
const deviceRoute = await readFile(
  new URL('../app/api/computer/devices/[deviceId]/route.js', import.meta.url),
  'utf8',
);
const devicesListRoute = await readFile(new URL('../app/api/computer/devices/route.js', import.meta.url), 'utf8');

function functionBody(name) {
  const start = migration.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `function ${name} is declared`);
  const end = migration.indexOf('$function$;', start);
  assert.notEqual(end, -1, `function ${name} closes`);
  return migration.slice(start, end);
}

test('unauthenticated and unauthorized access is denied; explicitly enabled customer access passes', () => {
  assert.deepEqual(computerAccessFailure(null), {
    error: true,
    code: 'AUTH_REQUIRED',
    message: 'تعذر التحقق من صلاحية الحساب.',
    status: 401,
  });
  assert.equal(computerAccessFailure({ ok: false, code: 'AUTH_INVALID', status: 401 }).code, 'AUTH_INVALID');
  assert.equal(
    computerAccessFailure({ ok: true, customer: { allow_computer_pairing: false } }).status,
    403,
  );
  assert.equal(
    computerAccessFailure({ ok: true, customer: { allow_computer_pairing: true } }),
    null,
  );
  assert.match(taskRoute, /const context = await requireComputerAccess\(request\)/);
  assert.match(approvalRoute, /const context = await requireComputerAccess\(request\)/);
  assert.match(deviceRoute, /const context = await requireComputerAccess\(request\)/);
  assert.match(devicesListRoute, /const context = await requireComputerAccess\(request\)/);
});

test('computer IDs require UUID syntax', () => {
  assert.equal(isComputerUuid('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(isComputerUuid('../550e8400-e29b-41d4-a716-446655440000'), false);
  assert.equal(isComputerUuid('not-a-uuid'), false);
  assert.equal(isComputerUuid(null), false);
});

test('request JSON parsing enforces a byte limit and rejects malformed or non-object JSON', async () => {
  const valid = await readComputerJson(new Request('https://local.test', {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved' }),
  }));
  assert.deepEqual(valid, { ok: true, value: { decision: 'approved' } });

  const invalid = await readComputerJson(new Request('https://local.test', {
    method: 'POST',
    body: '{',
  }));
  assert.deepEqual(invalid, { ok: false, code: 'INVALID_JSON' });

  const scalar = await readComputerJson(new Request('https://local.test', {
    method: 'POST',
    body: '[]',
  }));
  assert.deepEqual(scalar, { ok: false, code: 'INVALID_JSON' });

  const tooLarge = await readComputerJson(new Request('https://local.test', {
    method: 'POST',
    headers: { 'content-length': '13000' },
    body: '{}',
  }));
  assert.deepEqual(tooLarge, { ok: false, code: 'BODY_TOO_LARGE' });

  const oversizedStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(13 * 1024));
      controller.close();
    },
  });
  const streamResult = await readComputerJson(new Request('https://local.test', {
    method: 'POST',
    body: oversizedStream,
    duplex: 'half',
  }));
  assert.deepEqual(streamResult, { ok: false, code: 'BODY_TOO_LARGE' });
});

test('task payload validation enforces a per-type allowlist and explicit bounded Windows scope', () => {
  const root = 'C:\\Users\\Alice\\Documents';
  assert.equal(validateComputerTask('list_files', { authorizedRoot: root, path: 'Reports', maxEntries: 100 }), null);
  assert.equal(validateComputerTask('search_files', { authorizedRoot: root, query: 'invoice', maxResults: 10 }), null);
  assert.equal(validateComputerTask('file_metadata', { authorizedRoot: root, path: 'Reports\\invoice.pdf' }), null);
  assert.equal(
    validateComputerTask('transfer_file', {
      authorizedRoot: root,
      sourcePath: 'incoming\\invoice.pdf',
      destinationPath: 'archive\\invoice.pdf',
    }),
    null,
  );

  assert.notEqual(validateComputerTask('list_files', { authorizedRoot: root, command: 'dir' }), null);
  assert.notEqual(validateComputerTask('list_files', { authorizedRoot: root, path: '..\\Windows' }), null);
  assert.notEqual(validateComputerTask('file_metadata', { authorizedRoot: 'C:\\', path: 'file.txt' }), null);
  assert.notEqual(validateComputerTask('file_metadata', { authorizedRoot: root, path: 'C:\\Windows\\file' }), null);
  assert.notEqual(
    validateComputerTask('transfer_file', {
      authorizedRoot: root,
      sourcePath: 'file.txt',
      destinationPath: '..\\outside.txt',
    }),
    null,
  );
  assert.notEqual(
    validateComputerTask('search_files', { authorizedRoot: root, query: 'x'.repeat(257) }),
    null,
  );
  assert.notEqual(
    validateComputerTask('search_files', { authorizedRoot: root, query: 'x', maxResults: 101 }),
    null,
  );
  assert.notEqual(validateComputerTask('run_command', { authorizedRoot: root }), null);
});

test('task creation uses the authenticated owner and one atomic server-only database function', () => {
  const body = functionBody('create_computer_task_with_approval');
  assert.match(body, /customer\.allow_computer_pairing/);
  assert.match(body, /customer\.user_id = p_user_id/);
  assert.match(body, /device\.user_id = p_user_id/);
  assert.match(body, /device\.status = 'active'/);
  assert.match(body, /for update/);
  assert.ok(body.indexOf('v_now := clock_timestamp()') > body.indexOf('for update'));
  const taskInsert = body.indexOf('insert into public.computer_tasks');
  const approvalInsert = body.indexOf('insert into public.computer_task_approvals');
  const auditInsert = body.indexOf('insert into public.computer_audit_logs');
  assert.ok(taskInsert >= 0 && approvalInsert > taskInsert && auditInsert > approvalInsert);
  assert.match(taskRoute, /p_user_id:\s*access\.user\.id/);
  assert.match(taskRoute, /callComputerRpc\(service, 'create_computer_task_with_approval'/);
  assert.doesNotMatch(taskRoute, /\.from\('computer_tasks'\)\s*\.insert/);
  assert.doesNotMatch(taskRoute, /\.from\('computer_task_approvals'\)\s*\.insert/);
});

test('approval decisions lock owner-scoped rows, expire atomically, and prevent repeated decisions', () => {
  const body = functionBody('decide_computer_task_approval');
  assert.match(body, /task\.user_id = p_user_id/);
  assert.match(body, /device\.user_id = p_user_id[\s\S]*?for update/);
  assert.match(body, /approval\.user_id = p_user_id[\s\S]*?for update/);
  assert.match(
    body,
    /select device\.status[\s\S]*?for update;[\s\S]*?select task\.\*[\s\S]*?for update;[\s\S]*?select approval\.\*[\s\S]*?for update;/,
    'approval locks the device before task and approval, matching revocation order',
  );
  assert.match(body, /v_device_status <> 'active'/);
  assert.ok(body.indexOf('v_now := clock_timestamp()') > body.lastIndexOf('for update'));
  assert.match(body, /v_task\.expires_at <= v_now or v_approval\.expires_at <= v_now/);
  assert.match(body, /set decision = 'expired', decided_at = v_now/);
  assert.match(body, /set status = 'expired', updated_at = v_now/);
  assert.match(body, /return jsonb_build_object\('outcome', 'already_decided'\)/);
  assert.match(approvalRoute, /p_user_id:\s*access\.user\.id/);
  assert.match(approvalRoute, /callComputerRpc\(service, 'decide_computer_task_approval'/);
  assert.match(approvalRoute, /data\?\.outcome === 'device_not_active'/);
  assert.doesNotMatch(approvalRoute, /\.from\('computer_task_approvals'\)\s*\.update/);
  assert.doesNotMatch(approvalRoute, /\.from\('computer_tasks'\)\s*\.update/);
});

test('device revocation and its audit record are atomic and do not touch phone state', () => {
  const body = functionBody('revoke_computer_device');
  assert.match(body, /device\.user_id = p_user_id[\s\S]*?for update/);
  assert.match(body, /if v_status = 'revoked' then[\s\S]*?already_revoked/);
  assert.ok(body.indexOf('update public.computer_devices') < body.indexOf('insert into public.computer_audit_logs'));
  assert.match(deviceRoute, /callComputerRpc\(service, 'revoke_computer_device'/);
  assert.match(deviceRoute, /data\?\.outcome === 'already_revoked'/);
  assert.doesNotMatch(body, /device_bound_at|customer_registry|bind_customer_device/i);
});

test('device revocation atomically cancels nonterminal tasks, expires pending approvals, and audits each cancellation', () => {
  const body = functionBody('revoke_computer_device');
  const taskUpdate = body.indexOf('update public.computer_tasks');
  const approvalUpdate = body.indexOf('update public.computer_task_approvals');
  const taskAudit = body.indexOf("'task_cancelled'");
  const deviceAudit = body.indexOf("'device_revoked'");

  assert.ok(taskUpdate >= 0 && approvalUpdate > taskUpdate && taskAudit > approvalUpdate);
  assert.match(body, /status in \('queued', 'awaiting_approval', 'approved', 'running'\)/);
  assert.match(body, /set decision = 'expired', decided_at = v_now/);
  assert.match(body, /jsonb_build_object\('reason', 'device_revoked'\)/);
  assert.ok(deviceAudit > taskAudit);
  assert.match(body, /for update/);
});

test('audit rows are constrained to the owner and task-device relationship', () => {
  assert.match(
    migration,
    /unique \(user_id, device_id, id\)/,
  );
  assert.match(
    migration,
    /computer_audit_logs_device_owner_fk[\s\S]*?foreign key \(user_id, device_id\)\s+references public\.computer_devices\(user_id, id\)/,
  );
  assert.match(
    migration,
    /computer_audit_logs_task_owner_fk[\s\S]*?foreign key \(user_id, task_id\)\s+references public\.computer_tasks\(user_id, id\)/,
  );
  assert.match(
    migration,
    /computer_audit_logs_task_device_owner_fk[\s\S]*?foreign key \(user_id, device_id, task_id\)\s+references public\.computer_tasks\(user_id, device_id, id\)/,
  );
});

test('database functions are invoker-scoped, owner-bound, and executable only by service_role', () => {
  assert.match(migration, /^\s*begin;\s*$/im);
  assert.match(migration, /^\s*commit;\s*$/im);
  for (const [name, signature] of [
    ['create_computer_task_with_approval', 'uuid, uuid, text, jsonb'],
    ['decide_computer_task_approval', 'uuid, uuid, text'],
    ['revoke_computer_device', 'uuid, uuid'],
  ]) {
    assert.match(functionBody(name), /security invoker/i);
    const argumentPattern = signature.split(', ').join('\\s*,\\s*');
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${name}\\(\\s*${argumentPattern}\\s*\\)\\s+from public, anon, authenticated;`),
    );
    assert.match(
      migration,
      new RegExp(`grant execute on function public\\.${name}\\(\\s*${argumentPattern}\\s*\\)\\s+to service_role;`),
    );
  }
  assert.match(migration, /set search_path = pg_catalog, public/);
});

test('API routes do not accept user identity from request bodies and preserve owner scoping on reads', () => {
  assert.match(taskRoute, /\.eq\('user_id', access\.user\.id\)/);
  assert.match(devicesListRoute, /\.eq\('user_id', access\.user\.id\)/);
  assert.match(taskRoute, /Object\.keys\(body\)\.some\(\(key\) => !\['deviceId', 'taskType', 'payload'\]\.includes\(key\)\)/);
  assert.match(approvalRoute, /Object\.keys\(body\)\.some\(\(key\) => key !== 'decision'\)/);
  assert.doesNotMatch(taskRoute, /body\??\.userId|body\.user_id/);
  assert.doesNotMatch(approvalRoute, /body\??\.userId|body\.user_id/);
});
