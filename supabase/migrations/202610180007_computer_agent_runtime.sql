-- Local phase-five migration. Do NOT apply to Supabase until reviewed and tested.
-- Device requests are Ed25519-authenticated, replay-protected, and task-scoped.
begin;

create table public.computer_device_request_nonces (
  device_id uuid not null references public.computer_devices(id) on delete cascade,
  nonce text not null check (nonce ~ '^[A-Za-z0-9_-]{32}$'),
  created_at timestamptz not null default now(),
  primary key (device_id, nonce)
);

create index computer_device_request_nonces_created_idx
  on public.computer_device_request_nonces(created_at);

alter table public.computer_device_request_nonces enable row level security;
revoke all on public.computer_device_request_nonces from public, anon, authenticated;
grant all on public.computer_device_request_nonces to service_role;

create or replace function public.consume_computer_device_nonce(
  p_device_id uuid,
  p_nonce text,
  p_timestamp bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_status text;
  v_now timestamptz := clock_timestamp();
begin
  if p_device_id is null or p_nonce is null
    or p_nonce !~ '^[A-Za-z0-9_-]{32}$'
    or p_timestamp is null
    or abs(extract(epoch from v_now)::bigint - p_timestamp) > 120 then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select device.status
    into v_status
    from public.computer_devices as device
    where device.id = p_device_id
    for update;

  if not found or v_status <> 'active' then
    return jsonb_build_object('outcome', 'device_not_active');
  end if;

  delete from public.computer_device_request_nonces
    where created_at < v_now - interval '10 minutes';

  insert into public.computer_device_request_nonces(device_id, nonce, created_at)
  values (p_device_id, p_nonce, v_now)
  on conflict (device_id, nonce) do nothing;

  if not found then
    return jsonb_build_object('outcome', 'replay');
  end if;

  update public.computer_devices
    set last_seen_at = v_now, updated_at = v_now
    where id = p_device_id and status = 'active';

  return jsonb_build_object('outcome', 'accepted');
end;
$function$;

create or replace function public.claim_computer_task(p_device_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid;
  v_device_status text;
  v_task public.computer_tasks%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select device.user_id, device.status
    into v_user_id, v_device_status
    from public.computer_devices as device
    where device.id = p_device_id
    for update;

  if not found or v_device_status <> 'active' then
    return jsonb_build_object('outcome', 'device_not_active');
  end if;

  select task.*
    into v_task
    from public.computer_tasks as task
    where task.device_id = p_device_id
      and task.user_id = v_user_id
      and task.status = 'approved'
    order by task.created_at
    limit 1
    for update skip locked;

  if not found then
    return jsonb_build_object('outcome', 'empty');
  end if;

  if v_task.expires_at <= v_now then
    update public.computer_tasks
      set status = 'expired', updated_at = v_now
      where id = v_task.id;

    update public.computer_task_approvals
      set decision = 'expired', decided_at = v_now
      where task_id = v_task.id and decision = 'approved';

    insert into public.computer_audit_logs (
      user_id, device_id, task_id, actor_type, event_type, details
    )
    values (
      v_user_id, p_device_id, v_task.id, 'system', 'task_expired',
      jsonb_build_object('source', 'agent_claim')
    );
    return jsonb_build_object('outcome', 'task_expired');
  end if;

  update public.computer_tasks
    set status = 'running', started_at = v_now, updated_at = v_now
    where id = v_task.id
    returning * into v_task;

  insert into public.computer_audit_logs (
    user_id, device_id, task_id, actor_type, event_type, details
  )
  values (v_user_id, p_device_id, v_task.id, 'computer', 'task_started', '{}'::jsonb);

  return jsonb_build_object(
    'outcome', 'claimed',
    'task', jsonb_build_object(
      'id', v_task.id,
      'task_type', v_task.task_type,
      'payload', v_task.payload,
      'expires_at', v_task.expires_at
    )
  );
end;
$function$;

create or replace function public.report_computer_task_result(
  p_device_id uuid,
  p_task_id uuid,
  p_status text,
  p_result jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid;
  v_device_status text;
  v_task public.computer_tasks%rowtype;
  v_now timestamptz := clock_timestamp();
  v_event_type text;
begin
  if p_device_id is null or p_task_id is null
    or p_status not in ('succeeded', 'failed')
    or p_result is null or jsonb_typeof(p_result) <> 'object'
    or octet_length(p_result::text) > 8192 then
    raise exception using errcode = '22023', message = 'Invalid computer task result';
  end if;

  select device.user_id, device.status
    into v_user_id, v_device_status
    from public.computer_devices as device
    where device.id = p_device_id
    for update;

  if not found or v_device_status <> 'active' then
    return jsonb_build_object('outcome', 'device_not_active');
  end if;

  select task.*
    into v_task
    from public.computer_tasks as task
    where task.id = p_task_id
      and task.device_id = p_device_id
      and task.user_id = v_user_id
    for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_task.status <> 'running' then
    return jsonb_build_object('outcome', 'already_finished');
  end if;

  if v_task.expires_at <= v_now then
    update public.computer_tasks
      set status = 'expired', updated_at = v_now, completed_at = v_now
      where id = p_task_id
      returning * into v_task;
    v_event_type := 'task_expired';
  else
    update public.computer_tasks
      set status = p_status, result = p_result, updated_at = v_now, completed_at = v_now
      where id = p_task_id
      returning * into v_task;
    v_event_type := case when p_status = 'succeeded' then 'task_completed' else 'task_failed' end;
  end if;

  insert into public.computer_audit_logs (
    user_id, device_id, task_id, actor_type, event_type, details
  )
  values (
    v_user_id, p_device_id, p_task_id, 'computer', v_event_type,
    jsonb_build_object('status', v_task.status)
  );

  return jsonb_build_object('outcome', 'reported', 'status', v_task.status);
end;
$function$;

create or replace function public.cancel_computer_task(
  p_user_id uuid,
  p_task_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_task public.computer_tasks%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null or p_task_id is null then
    raise exception using errcode = '22023', message = 'Invalid computer task cancellation input';
  end if;

  select task.*
    into v_task
    from public.computer_tasks as task
    where task.id = p_task_id and task.user_id = p_user_id;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  perform 1
    from public.computer_devices as device
    where device.id = v_task.device_id and device.user_id = p_user_id
    for update;

  select task.*
    into v_task
    from public.computer_tasks as task
    where task.id = p_task_id and task.user_id = p_user_id
    for update;

  if v_task.status not in ('queued', 'awaiting_approval', 'approved', 'running') then
    return jsonb_build_object('outcome', 'already_finished');
  end if;

  update public.computer_tasks
    set status = 'cancelled', updated_at = v_now
    where id = p_task_id and user_id = p_user_id;

  update public.computer_task_approvals
    set decision = 'expired', decided_at = v_now
    where task_id = p_task_id and user_id = p_user_id and decision = 'pending';

  insert into public.computer_audit_logs (
    user_id, device_id, task_id, actor_type, event_type, details
  )
  values (
    p_user_id, v_task.device_id, p_task_id, 'customer', 'task_cancelled',
    jsonb_build_object('reason', 'customer_cancelled')
  );

  return jsonb_build_object('outcome', 'cancelled');
end;
$function$;

revoke all on function public.consume_computer_device_nonce(uuid, text, bigint)
  from public, anon, authenticated;
revoke all on function public.claim_computer_task(uuid)
  from public, anon, authenticated;
revoke all on function public.report_computer_task_result(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.cancel_computer_task(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.consume_computer_device_nonce(uuid, text, bigint) to service_role;
grant execute on function public.claim_computer_task(uuid) to service_role;
grant execute on function public.report_computer_task_result(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.cancel_computer_task(uuid, uuid) to service_role;

commit;
