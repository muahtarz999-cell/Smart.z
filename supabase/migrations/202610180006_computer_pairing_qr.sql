-- Local phase-four migration. Do NOT apply to Supabase until reviewed and tested.
-- QR pairing links one approved phone account to a computer public key only.
begin;

create table public.computer_pairing_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  public_key text not null,
  challenge text not null,
  label text not null
    check (char_length(label) between 1 and 64),
  creator_ip_hash text not null
    check (creator_ip_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid references public.customer_registry(user_id) on delete cascade,
  device_id uuid,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'completed', 'expired')),
  replace_existing boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  completed_at timestamptz,

  constraint computer_pairing_sessions_lifecycle_check
    check (
      (status = 'pending' and approved_at is null and completed_at is null)
      or (status = 'approved' and user_id is not null and approved_at is not null and completed_at is null)
      or (status = 'rejected' and user_id is not null and completed_at is null)
      or (status = 'completed' and user_id is not null and device_id is not null and approved_at is not null and completed_at is not null)
      or (status = 'expired' and device_id is null and completed_at is null)
    ),
  constraint computer_pairing_sessions_expiry_check
    check (expires_at > created_at),
  constraint computer_pairing_sessions_device_owner_fk
    foreign key (user_id, device_id)
    references public.computer_devices(user_id, id),
  constraint computer_pairing_sessions_lifecycle_device_check
    check ((status = 'completed') = (device_id is not null))
);

create index computer_pairing_sessions_ip_created_idx
  on public.computer_pairing_sessions(creator_ip_hash, created_at desc);
create index computer_pairing_sessions_user_status_idx
  on public.computer_pairing_sessions(user_id, status, expires_at);

create unique index computer_devices_one_active_per_user_uidx
  on public.computer_devices(user_id)
  where status = 'active';

alter table public.computer_pairing_sessions enable row level security;
revoke all on public.computer_pairing_sessions from public, anon, authenticated;
grant all on public.computer_pairing_sessions to service_role;

create or replace function public.create_computer_pairing_session(
  p_token_hash text,
  p_public_key text,
  p_challenge text,
  p_label text,
  p_creator_ip_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_session public.computer_pairing_sessions%rowtype;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_creator_ip_hash is null or p_creator_ip_hash !~ '^[0-9a-f]{64}$'
    or p_public_key is null or char_length(p_public_key) > 128
    or p_challenge is null or char_length(p_challenge) not between 40 and 64
    or p_label is null or char_length(p_label) not between 1 and 64 then
    raise exception using errcode = '22023', message = 'Invalid computer pairing session input';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('computer_pairing_sessions'),
    hashtext(p_creator_ip_hash)
  );

  if (
    select count(*)
    from public.computer_pairing_sessions as session
    where session.creator_ip_hash = p_creator_ip_hash
      and session.created_at > v_now - interval '15 minutes'
  ) >= 10 then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  delete from public.computer_pairing_sessions
    where created_at < v_now - interval '1 day';

  insert into public.computer_pairing_sessions (
    token_hash, public_key, challenge, label, creator_ip_hash, expires_at, created_at
  )
  values (
    p_token_hash, p_public_key, p_challenge, p_label,
    p_creator_ip_hash, v_now + interval '5 minutes', v_now
  )
  returning * into v_session;

  return jsonb_build_object(
    'outcome', 'created',
    'sessionId', v_session.id,
    'expiresAt', v_session.expires_at
  );
end;
$function$;

create or replace function public.get_computer_pairing_session_status(
  p_session_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_session public.computer_pairing_sessions%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select session.*
    into v_session
    from public.computer_pairing_sessions as session
    where session.id = p_session_id
      and session.token_hash = p_token_hash
    for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_session.status in ('pending', 'approved') and v_session.expires_at <= v_now then
    update public.computer_pairing_sessions
      set status = 'expired'
      where id = p_session_id;
    v_session.status := 'expired';
  end if;

  return jsonb_build_object(
    'outcome', 'ok',
    'status', v_session.status,
    'label', v_session.label,
    'expiresAt', v_session.expires_at,
    'challenge', case when v_session.status = 'approved' then v_session.challenge else null end,
    'deviceId', case when v_session.status = 'completed' then v_session.device_id else null end
  );
end;
$function$;

create or replace function public.decide_computer_pairing_session(
  p_session_id uuid,
  p_token_hash text,
  p_user_id uuid,
  p_decision text,
  p_replace_existing boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_allowed boolean;
  v_customer_active boolean;
  v_session public.computer_pairing_sessions%rowtype;
  v_active_device public.computer_devices%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_session_id is null or p_user_id is null
    or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_decision is null
    or p_decision not in ('approve', 'reject')
    or p_replace_existing is null then
    raise exception using errcode = '22023', message = 'Invalid computer pairing decision';
  end if;

  select customer.allow_computer_pairing,
         coalesce(customer.is_active, true)
    into v_allowed, v_customer_active
    from public.customer_registry as customer
    where customer.user_id = p_user_id
    for update;

  if not found or v_allowed is distinct from true or v_customer_active is distinct from true then
    return jsonb_build_object('outcome', 'not_allowed');
  end if;

  select session.*
    into v_session
    from public.computer_pairing_sessions as session
    where session.id = p_session_id
      and session.token_hash = p_token_hash
    for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_session.expires_at <= v_now then
    if v_session.status in ('pending', 'approved') then
      update public.computer_pairing_sessions
        set status = 'expired'
        where id = p_session_id;
    end if;
    return jsonb_build_object('outcome', 'expired');
  end if;

  if p_decision = 'reject' then
    if v_session.status not in ('pending', 'approved')
      or (v_session.user_id is not null and v_session.user_id <> p_user_id) then
      return jsonb_build_object('outcome', 'already_decided');
    end if;

    update public.computer_pairing_sessions
      set status = 'rejected', user_id = p_user_id
      where id = p_session_id;

    insert into public.computer_audit_logs (
      user_id, actor_type, event_type, details
    )
    values (
      p_user_id, 'customer', 'pairing_rejected',
      jsonb_build_object('sessionId', p_session_id)
    );

    return jsonb_build_object('outcome', 'rejected');
  end if;

  if v_session.status not in ('pending', 'approved')
    or (v_session.user_id is not null and v_session.user_id <> p_user_id) then
    return jsonb_build_object('outcome', 'already_decided');
  end if;

  select device.*
    into v_active_device
    from public.computer_devices as device
    where device.user_id = p_user_id
      and device.status = 'active'
    for update;

  if found and not p_replace_existing then
    return jsonb_build_object(
      'outcome', 'replacement_required',
      'activeDeviceLabel', v_active_device.label
    );
  end if;

  update public.computer_pairing_sessions
    set status = 'approved',
        user_id = p_user_id,
        replace_existing = p_replace_existing,
        approved_at = coalesce(approved_at, v_now)
    where id = p_session_id;

  return jsonb_build_object('outcome', 'approved');
end;
$function$;

create or replace function public.cancel_computer_pairing_session(
  p_session_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_session public.computer_pairing_sessions%rowtype;
begin
  if p_session_id is null or p_token_hash is null
    or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid computer pairing session token';
  end if;

  select session.*
    into v_session
    from public.computer_pairing_sessions as session
    where session.id = p_session_id
      and session.token_hash = p_token_hash
    for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_session.status in ('pending', 'approved') then
    update public.computer_pairing_sessions
      set status = 'expired'
      where id = p_session_id;
    return jsonb_build_object('outcome', 'cancelled');
  end if;

  return jsonb_build_object('outcome', 'already_finished');
end;
$function$;

create or replace function public.complete_computer_pairing_session(
  p_session_id uuid,
  p_token_hash text,
  p_proof_verified boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid;
  v_allowed boolean;
  v_customer_active boolean;
  v_session public.computer_pairing_sessions%rowtype;
  v_active_device public.computer_devices%rowtype;
  v_device public.computer_devices%rowtype;
  v_existing_device public.computer_devices%rowtype;
  v_task_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_session_id is null
    or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_proof_verified is distinct from true then
    return jsonb_build_object('outcome', 'invalid_proof');
  end if;

  select session.user_id
    into v_user_id
    from public.computer_pairing_sessions as session
    where session.id = p_session_id
      and session.token_hash = p_token_hash;

  if not found or v_user_id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select customer.allow_computer_pairing,
         coalesce(customer.is_active, true)
    into v_allowed, v_customer_active
    from public.customer_registry as customer
    where customer.user_id = v_user_id
    for update;

  if not found or v_allowed is distinct from true or v_customer_active is distinct from true then
    return jsonb_build_object('outcome', 'not_allowed');
  end if;

  select session.*
    into v_session
    from public.computer_pairing_sessions as session
    where session.id = p_session_id
      and session.token_hash = p_token_hash
      and session.user_id = v_user_id
    for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_session.status = 'completed' then
    return jsonb_build_object('outcome', 'paired', 'deviceId', v_session.device_id);
  end if;

  if v_session.status <> 'approved' then
    return jsonb_build_object('outcome', 'not_approved');
  end if;

  if v_session.expires_at <= v_now then
    update public.computer_pairing_sessions
      set status = 'expired'
      where id = p_session_id;
    return jsonb_build_object('outcome', 'expired');
  end if;

  select device.*
    into v_active_device
    from public.computer_devices as device
    where device.user_id = v_user_id
      and device.status = 'active'
    for update;

  if found and not v_session.replace_existing then
    return jsonb_build_object(
      'outcome', 'replacement_required',
      'activeDeviceLabel', v_active_device.label
    );
  end if;

  if found then
    update public.computer_devices
      set status = 'revoked', revoked_at = v_now, updated_at = v_now
      where id = v_active_device.id
        and user_id = v_user_id
        and status = 'active';

    for v_task_id in
      update public.computer_tasks
        set status = 'cancelled', updated_at = v_now
        where user_id = v_user_id
          and device_id = v_active_device.id
          and status in ('queued', 'awaiting_approval', 'approved', 'running')
        returning id
    loop
      update public.computer_task_approvals
        set decision = 'expired', decided_at = v_now
        where user_id = v_user_id
          and task_id = v_task_id
          and decision = 'pending';

      insert into public.computer_audit_logs (
        user_id, device_id, task_id, actor_type, event_type, details
      )
      values (
        v_user_id, v_active_device.id, v_task_id, 'customer', 'task_cancelled',
        jsonb_build_object('reason', 'computer_replaced')
      );
    end loop;

    insert into public.computer_audit_logs (
      user_id, device_id, actor_type, event_type, details
    )
    values (
      v_user_id, v_active_device.id, 'customer', 'device_revoked',
      jsonb_build_object('reason', 'computer_replaced')
    );
  end if;

  select device.*
    into v_existing_device
    from public.computer_devices as device
    where device.user_id = v_user_id
      and device.public_key = v_session.public_key
    for update;

  if found then
    update public.computer_devices
      set label = v_session.label,
          status = 'active',
          paired_at = v_now,
          last_seen_at = null,
          revoked_at = null,
          pairing_challenge_hash = null,
          pairing_expires_at = null,
          updated_at = v_now
      where id = v_existing_device.id
        and user_id = v_user_id
      returning * into v_device;
  else
    insert into public.computer_devices (
      user_id, label, public_key, status, paired_at, created_at, updated_at
    )
    values (
      v_user_id, v_session.label, v_session.public_key, 'active', v_now, v_now, v_now
    )
    returning * into v_device;
  end if;

  update public.computer_pairing_sessions
    set status = 'completed', device_id = v_device.id, completed_at = v_now
    where id = p_session_id;

  insert into public.computer_audit_logs (
    user_id, device_id, actor_type, event_type, details
  )
  values (
    v_user_id, v_device.id, 'customer', 'pairing_approved',
    jsonb_build_object('sessionId', p_session_id, 'label', v_device.label)
  );

  return jsonb_build_object('outcome', 'paired', 'deviceId', v_device.id);
end;
$function$;

revoke all on function public.create_computer_pairing_session(text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.get_computer_pairing_session_status(uuid, text)
  from public, anon, authenticated;
revoke all on function public.cancel_computer_pairing_session(uuid, text)
  from public, anon, authenticated;
revoke all on function public.decide_computer_pairing_session(uuid, text, uuid, text, boolean)
  from public, anon, authenticated;
revoke all on function public.complete_computer_pairing_session(uuid, text, boolean)
  from public, anon, authenticated;

grant execute on function public.create_computer_pairing_session(text, text, text, text, text)
  to service_role;
grant execute on function public.get_computer_pairing_session_status(uuid, text)
  to service_role;
grant execute on function public.cancel_computer_pairing_session(uuid, text)
  to service_role;
grant execute on function public.decide_computer_pairing_session(uuid, text, uuid, text, boolean)
  to service_role;
grant execute on function public.complete_computer_pairing_session(uuid, text, boolean)
  to service_role;

comment on table public.computer_pairing_sessions is
  'Short-lived QR pairing sessions; only a SHA-256 token hash is stored.';

commit;
