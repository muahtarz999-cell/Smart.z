-- Smart.z: Computer Pairing Foundation
-- Phase 2: schema only; no live pairing execution.
-- Do not modify phone pairing or the existing device lock.

begin;

-- Registered computers belonging to a customer.
create table if not exists public.computer_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.customer_registry(user_id) on delete cascade,
  label text not null default 'Windows computer',
  public_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'revoked')),
  paired_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint computer_devices_user_id_id_unique
    unique (user_id, id),

  constraint computer_devices_user_public_key_unique
    unique (user_id, public_key),

  constraint computer_devices_revoked_consistency
    check (
      (status = 'revoked' and revoked_at is not null)
      or
      (status <> 'revoked' and revoked_at is null)
    )
);

create index if not exists computer_devices_user_status_idx
  on public.computer_devices(user_id, status);

-- Allowlisted task types only; no arbitrary shell commands.
create table if not exists public.computer_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.customer_registry(user_id) on delete cascade,
  device_id uuid not null,
  task_type text not null
    check (
      task_type in (
        'list_files',
        'search_files',
        'file_metadata',
        'transfer_file'
      )
    ),
  status text not null default 'queued'
    check (
      status in (
        'queued',
        'awaiting_approval',
        'approved',
        'running',
        'succeeded',
        'failed',
        'cancelled',
        'expired'
      )
    ),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  result jsonb
    check (result is null or jsonb_typeof(result) = 'object'),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint computer_tasks_user_id_id_unique
    unique (user_id, id),

  constraint computer_tasks_device_owner_fk
    foreign key (user_id, device_id)
    references public.computer_devices(user_id, id)
    on delete cascade,

  constraint computer_tasks_expiry_check
    check (expires_at > created_at)
);

create index if not exists computer_tasks_user_status_created_idx
  on public.computer_tasks(user_id, status, created_at desc);

create index if not exists computer_tasks_device_status_idx
  on public.computer_tasks(device_id, status);

create index if not exists computer_tasks_expiry_idx
  on public.computer_tasks(expires_at)
  where status in ('queued', 'awaiting_approval', 'approved');

-- Explicit approval records for sensitive operations.
create table if not exists public.computer_task_approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.customer_registry(user_id) on delete cascade,
  task_id uuid not null,
  decision text not null default 'pending'
    check (decision in ('pending', 'approved', 'rejected', 'expired')),
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  decided_at timestamptz,
  created_at timestamptz not null default now(),

  constraint computer_task_approvals_task_owner_fk
    foreign key (user_id, task_id)
    references public.computer_tasks(user_id, id)
    on delete cascade,

  constraint computer_task_approvals_one_per_task
    unique (user_id, task_id),

  constraint computer_task_approvals_expiry_check
    check (expires_at > requested_at),

  constraint computer_task_approvals_decision_consistency
    check (
      (decision = 'pending' and decided_at is null)
      or
      (decision <> 'pending' and decided_at is not null)
    )
);

create index if not exists computer_task_approvals_pending_idx
  on public.computer_task_approvals(user_id, expires_at)
  where decision = 'pending';

-- Minimal audit metadata. Do not store file contents, secrets,
-- pairing tokens, private keys, or authentication credentials here.
create table if not exists public.computer_audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.customer_registry(user_id) on delete cascade,
  device_id uuid,
  task_id uuid,
  actor_type text not null
    check (actor_type in ('customer', 'admin', 'computer', 'system')),
  event_type text not null
    check (
      event_type in (
        'pairing_requested',
        'pairing_approved',
        'pairing_rejected',
        'device_revoked',
        'task_created',
        'approval_decided',
        'task_started',
        'task_completed',
        'task_failed',
        'task_cancelled',
        'task_expired'
      )
    ),
  details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists computer_audit_logs_user_created_idx
  on public.computer_audit_logs(user_id, created_at desc);

create index if not exists computer_audit_logs_task_idx
  on public.computer_audit_logs(task_id)
  where task_id is not null;

-- No direct table access from clients. Server-side APIs must authenticate
-- and authorize each operation before using the service role.
alter table public.computer_devices enable row level security;
alter table public.computer_tasks enable row level security;
alter table public.computer_task_approvals enable row level security;
alter table public.computer_audit_logs enable row level security;

revoke all on public.computer_devices
  from public, anon, authenticated;
revoke all on public.computer_tasks
  from public, anon, authenticated;
revoke all on public.computer_task_approvals
  from public, anon, authenticated;
revoke all on public.computer_audit_logs
  from public, anon, authenticated;

grant all on public.computer_devices to service_role;
grant all on public.computer_tasks to service_role;
grant all on public.computer_task_approvals to service_role;
grant all on public.computer_audit_logs to service_role;

comment on table public.computer_devices is
  'Registered customer computers. Pairing protocol is implemented in a later phase.';
comment on table public.computer_tasks is
  'Allowlisted computer task queue; does not authorize arbitrary command execution.';
comment on table public.computer_task_approvals is
  'Explicit, expiring approval records for computer tasks.';
comment on table public.computer_audit_logs is
  'Minimal audit metadata; must not contain credentials or file contents.';

commit;
