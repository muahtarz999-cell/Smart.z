-- Local phase-three migration. Do NOT apply to Supabase until reviewed.
-- These functions are server-only and do not implement computer execution.
begin;

alter table public.computer_tasks
  add constraint computer_tasks_user_device_id_unique
  unique (user_id, device_id, id);

alter table public.computer_audit_logs
  add constraint computer_audit_logs_device_owner_fk
  foreign key (user_id, device_id)
  references public.computer_devices(user_id, id),
  add constraint computer_audit_logs_task_owner_fk
  foreign key (user_id, task_id)
  references public.computer_tasks(user_id, id),
  add constraint computer_audit_logs_task_device_owner_fk
  foreign key (user_id, device_id, task_id)
  references public.computer_tasks(user_id, device_id, id);

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
    or p_task_type not in ('list_files', 'search_files', 'file_metadata', 'transfer_file')
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

create or replace function public.decide_computer_task_approval(
  p_user_id uuid,
  p_task_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_task public.computer_tasks%rowtype;
  v_approval public.computer_task_approvals%rowtype;
  v_device_status text;
  v_device_id uuid;
  v_cancel_reason text;
  v_next_status text;
  v_now timestamptz;
begin
  if p_user_id is null
    or p_task_id is null
    or p_decision is null
    or p_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'Invalid computer task approval input';
  end if;

  select task.device_id
    into v_device_id
    from public.computer_tasks as task
    where task.id = p_task_id
      and task.user_id = p_user_id;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select device.status
    into v_device_status
    from public.computer_devices as device
    where device.id = v_device_id
      and device.user_id = p_user_id
    for update;

  if not found or v_device_status <> 'active' then
    v_cancel_reason := case
      when v_device_status = 'revoked' then 'device_revoked'
      else 'device_not_active'
    end;

    select task.*
      into v_task
      from public.computer_tasks as task
      where task.id = p_task_id
        and task.user_id = p_user_id
      for update;

    if found and v_task.status in ('queued', 'awaiting_approval', 'approved', 'running') then
      update public.computer_tasks
        set status = 'cancelled', updated_at = clock_timestamp()
        where id = p_task_id and user_id = p_user_id;

      update public.computer_task_approvals
        set decision = 'expired', decided_at = clock_timestamp()
        where task_id = p_task_id
          and user_id = p_user_id
          and decision = 'pending';

      insert into public.computer_audit_logs (
        user_id, device_id, task_id, actor_type, event_type, details
      )
      values (
        p_user_id, v_task.device_id, p_task_id, 'customer', 'task_cancelled',
        jsonb_build_object('reason', v_cancel_reason)
      );
    end if;

    return jsonb_build_object('outcome', 'device_not_active');
  end if;

  select task.*
    into v_task
    from public.computer_tasks as task
    where task.id = p_task_id
      and task.user_id = p_user_id
    for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_task.device_id <> v_device_id then
    return jsonb_build_object('outcome', 'device_not_active');
  end if;

  select approval.*
    into v_approval
    from public.computer_task_approvals as approval
    where approval.task_id = p_task_id
      and approval.user_id = p_user_id
    for update;

  if not found then
    return jsonb_build_object('outcome', 'approval_missing');
  end if;

  v_now := clock_timestamp();

  if v_task.status <> 'awaiting_approval' or v_approval.decision <> 'pending' then
    return jsonb_build_object('outcome', 'already_decided');
  end if;

  if v_task.expires_at <= v_now or v_approval.expires_at <= v_now then
    update public.computer_tasks
      set status = 'expired', updated_at = v_now
      where id = p_task_id and user_id = p_user_id;

    update public.computer_task_approvals
      set decision = 'expired', decided_at = v_now
      where task_id = p_task_id and user_id = p_user_id;

    insert into public.computer_audit_logs (
      user_id, device_id, task_id, actor_type, event_type, details
    )
    values (
      p_user_id, v_task.device_id, p_task_id, 'customer', 'task_expired',
      jsonb_build_object('source', 'approval_decision')
    );

    return jsonb_build_object('outcome', 'expired');
  end if;

  v_next_status := case when p_decision = 'approved' then 'approved' else 'cancelled' end;

  update public.computer_task_approvals
    set decision = p_decision, decided_at = v_now
    where task_id = p_task_id and user_id = p_user_id;

  update public.computer_tasks
    set status = v_next_status, updated_at = v_now
    where id = p_task_id and user_id = p_user_id
    returning * into v_task;

  insert into public.computer_audit_logs (
    user_id, device_id, task_id, actor_type, event_type, details
  )
  values (
    p_user_id, v_task.device_id, p_task_id, 'customer', 'approval_decided',
    jsonb_build_object('decision', p_decision)
  );

  return jsonb_build_object(
    'outcome', 'decided',
    'decision', p_decision,
    'task', jsonb_build_object(
      'id', v_task.id,
      'status', v_task.status,
      'device_id', v_task.device_id
    )
  );
end;
$function$;

create or replace function public.revoke_computer_device(
  p_user_id uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_status text;
  v_task_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null or p_device_id is null then
    raise exception using errcode = '22023', message = 'Invalid computer device input';
  end if;

  select device.status
    into v_status
    from public.computer_devices as device
    where device.id = p_device_id
      and device.user_id = p_user_id
    for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_status = 'revoked' then
    return jsonb_build_object('outcome', 'already_revoked');
  end if;

  update public.computer_devices
    set status = 'revoked',
        revoked_at = v_now,
        pairing_challenge_hash = null,
        pairing_expires_at = null,
        updated_at = v_now
    where id = p_device_id and user_id = p_user_id;

  for v_task_id in
    update public.computer_tasks
      set status = 'cancelled', updated_at = v_now
      where user_id = p_user_id
        and device_id = p_device_id
        and status in ('queued', 'awaiting_approval', 'approved', 'running')
      returning id
  loop
    update public.computer_task_approvals
      set decision = 'expired', decided_at = v_now
      where user_id = p_user_id
        and task_id = v_task_id
        and decision = 'pending';

    insert into public.computer_audit_logs (
      user_id, device_id, task_id, actor_type, event_type, details
    )
    values (
      p_user_id, p_device_id, v_task_id, 'customer', 'task_cancelled',
      jsonb_build_object('reason', 'device_revoked')
    );
  end loop;

  insert into public.computer_audit_logs (
    user_id, device_id, actor_type, event_type, details
  )
  values (
    p_user_id, p_device_id, 'customer', 'device_revoked', '{}'::jsonb
  );

  return jsonb_build_object('outcome', 'revoked');
end;
$function$;

revoke all on function public.create_computer_task_with_approval(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.decide_computer_task_approval(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.revoke_computer_device(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.create_computer_task_with_approval(uuid, uuid, text, jsonb)
  to service_role;
grant execute on function public.decide_computer_task_approval(uuid, uuid, text)
  to service_role;
grant execute on function public.revoke_computer_device(uuid, uuid)
  to service_role;

comment on function public.create_computer_task_with_approval(uuid, uuid, text, jsonb) is
  'Atomically creates an owner-scoped computer task, pending approval, and audit record; callable only by service_role.';
comment on function public.decide_computer_task_approval(uuid, uuid, text) is
  'Atomically decides an unexpired owner-scoped task approval and records its audit event; callable only by service_role.';
comment on function public.revoke_computer_device(uuid, uuid) is
  'Atomically revokes an owner-scoped computer device and records the audit event; callable only by service_role.';

commit;
