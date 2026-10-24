-- Smart.z computer actions (owner request 2026-10-22).
-- Adds task types the Windows agent can now run:
--   open_file   : open a document inside an authorized folder with its default app
--   open_url    : open an http(s) link in the computer's browser
--   open_app    : start a program the user added to the agent's local allowlist
--   run_command : run a command the user added to the agent's local allowlist
-- The server only ever sends a NAME for apps/commands; the computer resolves it
-- from its own allowlist, so no path or command line travels from the server.
-- Apply after 202610180007 with: supabase db push   (or paste into the SQL editor)
begin;

do $migration$
declare
  v_constraint text;
begin
  for v_constraint in
    select con.conname
      from pg_constraint as con
      where con.conrelid = 'public.computer_tasks'::regclass
        and con.contype = 'c'
        and pg_get_constraintdef(con.oid) ilike '%task_type%'
  loop
    execute format('alter table public.computer_tasks drop constraint %I', v_constraint);
  end loop;
end;
$migration$;

alter table public.computer_tasks
  add constraint computer_tasks_task_type_check
  check (
    task_type in (
      'list_files',
      'search_files',
      'file_metadata',
      'transfer_file',
      'open_file',
      'open_url',
      'open_app',
      'run_command'
    )
  );

create or replace function public.create_computer_task_with_approval(
  p_user_id uuid,
  p_device_id uuid,
  p_task_type text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_allowed boolean;
  v_device_id uuid;
  v_now timestamptz;
  v_expires_at timestamptz;
  v_task public.computer_tasks%rowtype;
begin
  if p_user_id is null
    or p_device_id is null
    or p_task_type is null
    or p_task_type not in (
      'list_files', 'search_files', 'file_metadata', 'transfer_file',
      'open_file', 'open_url', 'open_app', 'run_command'
    )
    or p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 8192 then
    raise exception using errcode = '22023', message = 'Invalid computer task input';
  end if;

  select customer.allow_computer_pairing
    into v_allowed
    from public.customer_registry as customer
    where customer.user_id = p_user_id
    for share;

  if not found or v_allowed is distinct from true then
    return jsonb_build_object('outcome', 'not_allowed');
  end if;

  select device.id
    into v_device_id
    from public.computer_devices as device
    where device.id = p_device_id
      and device.user_id = p_user_id
      and device.status = 'active'
    for update;

  if not found then
    return jsonb_build_object('outcome', 'device_not_active');
  end if;

  v_now := clock_timestamp();
  v_expires_at := v_now + interval '10 minutes';

  insert into public.computer_tasks (
    user_id, device_id, task_type, status, payload, expires_at, created_at, updated_at
  )
  values (
    p_user_id, v_device_id, p_task_type, 'awaiting_approval',
    p_payload, v_expires_at, v_now, v_now
  )
  returning * into v_task;

  insert into public.computer_task_approvals (
    user_id, task_id, decision, requested_at, expires_at, created_at
  )
  values (
    p_user_id, v_task.id, 'pending', v_now, v_expires_at, v_now
  );

  insert into public.computer_audit_logs (
    user_id, device_id, task_id, actor_type, event_type, details
  )
  values (
    p_user_id, v_device_id, v_task.id, 'customer', 'task_created',
    jsonb_build_object('taskType', p_task_type)
  );

  return jsonb_build_object(
    'outcome', 'created',
    'task', jsonb_build_object(
      'id', v_task.id,
      'device_id', v_task.device_id,
      'task_type', v_task.task_type,
      'status', v_task.status,
      'expires_at', v_task.expires_at,
      'created_at', v_task.created_at
    )
  );
end;
$function$;

-- create or replace keeps the existing grants (service_role only).
commit;
