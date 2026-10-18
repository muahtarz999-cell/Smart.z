import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(
  new URL('../supabase/migrations/202610180003_computer_pairing_foundation.sql', import.meta.url),
  'utf8',
);

const tables = [
  'computer_devices',
  'computer_tasks',
  'computer_task_approvals',
  'computer_audit_logs',
];

function tableDefinition(name) {
  const start = migration.indexOf(`create table if not exists public.${name} (`);
  assert.notEqual(start, -1, `${name} table is created`);
  const end = migration.indexOf('\n);', start);
  assert.notEqual(end, -1, `${name} table definition closes`);
  return migration.slice(start, end + 3);
}

test('foundation migration is transactional and creates only the four foundation tables', () => {
  assert.match(migration, /^\s*begin;\s*$/im);
  assert.match(migration, /^\s*commit;\s*$/im);
  const createdTables = [...migration.matchAll(/create table if not exists public\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual(createdTables, tables);
  assert.doesNotMatch(migration, /\b(?:device_bound_at|bind_customer_device)\b/i);
  assert.doesNotMatch(migration, /alter table public\.customer_registry/i);
  assert.doesNotMatch(migration, /\/api\/whatsapp\/cluster\/connect|pairing_code/i);
});

test('all foundation tables have UUID primary keys and customer ownership foreign keys', () => {
  for (const name of tables) {
    const definition = tableDefinition(name);
    assert.match(definition, /id uuid primary key default gen_random_uuid\(\)/);
    assert.match(definition, /user_id uuid not null\s+references public\.customer_registry\(user_id\) on delete cascade/);
  }
});

test('devices enforce status, public-key uniqueness, owner identity, revocation consistency, and lookup index', () => {
  const definition = tableDefinition('computer_devices');
  assert.match(definition, /status in \('pending', 'active', 'revoked'\)/);
  assert.match(definition, /unique \(user_id, id\)/);
  assert.match(definition, /unique \(user_id, public_key\)/);
  assert.match(definition, /status = 'revoked' and revoked_at is not null/);
  assert.match(definition, /status <> 'revoked' and revoked_at is null/);
  assert.match(migration, /computer_devices_user_status_idx[\s\S]*?on public\.computer_devices\(user_id, status\)/);
});

test('tasks restrict types and states, bind the device to the same customer, and index lifecycle queries', () => {
  const definition = tableDefinition('computer_tasks');
  assert.match(definition, /task_type in \([\s\S]*?'list_files'[\s\S]*?'search_files'[\s\S]*?'file_metadata'[\s\S]*?'transfer_file'/);
  assert.match(definition, /status in \([\s\S]*?'queued'[\s\S]*?'awaiting_approval'[\s\S]*?'approved'[\s\S]*?'running'[\s\S]*?'succeeded'[\s\S]*?'failed'[\s\S]*?'cancelled'[\s\S]*?'expired'/);
  assert.match(definition, /jsonb_typeof\(payload\) = 'object'/);
  assert.match(definition, /result is null or jsonb_typeof\(result\) = 'object'/);
  assert.match(definition, /foreign key \(user_id, device_id\)\s+references public\.computer_devices\(user_id, id\)\s+on delete cascade/);
  assert.match(definition, /check \(expires_at > created_at\)/);
  assert.match(migration, /computer_tasks_user_status_created_idx/);
  assert.match(migration, /computer_tasks_device_status_idx/);
  assert.match(migration, /computer_tasks_expiry_idx[\s\S]*?where status in \('queued', 'awaiting_approval', 'approved'\)/);
});

test('approvals enforce one owner-scoped decision per task and pending/decided consistency', () => {
  const definition = tableDefinition('computer_task_approvals');
  assert.match(definition, /decision in \('pending', 'approved', 'rejected', 'expired'\)/);
  assert.match(definition, /foreign key \(user_id, task_id\)\s+references public\.computer_tasks\(user_id, id\)\s+on delete cascade/);
  assert.match(definition, /unique \(user_id, task_id\)/);
  assert.match(definition, /check \(expires_at > requested_at\)/);
  assert.match(definition, /decision = 'pending' and decided_at is null/);
  assert.match(definition, /decision <> 'pending' and decided_at is not null/);
  assert.match(migration, /computer_task_approvals_pending_idx[\s\S]*?where decision = 'pending'/);
});

test('audit records restrict actors and events and store object-only metadata', () => {
  const definition = tableDefinition('computer_audit_logs');
  assert.match(definition, /actor_type in \('customer', 'admin', 'computer', 'system'\)/);
  for (const event of [
    'pairing_requested', 'pairing_approved', 'pairing_rejected', 'device_revoked',
    'task_created', 'approval_decided', 'task_started', 'task_completed',
    'task_failed', 'task_cancelled', 'task_expired',
  ]) {
    assert.ok(definition.includes(`'${event}'`), `allows audit event ${event}`);
  }
  assert.match(definition, /jsonb_typeof\(details\) = 'object'/);
  assert.match(migration, /computer_audit_logs_user_created_idx/);
  assert.match(migration, /computer_audit_logs_task_idx[\s\S]*?where task_id is not null/);
  assert.match(migration, /must not contain credentials or file contents/i);
});

test('all four tables enable RLS, revoke direct client grants, and grant service role access', () => {
  for (const name of tables) {
    assert.match(migration, new RegExp(`alter table public\\.${name} enable row level security;`));
    assert.match(migration, new RegExp(`revoke all on public\\.${name}\\s+from public, anon, authenticated;`));
    assert.match(migration, new RegExp(`grant all on public\\.${name} to service_role;`));
  }
});
