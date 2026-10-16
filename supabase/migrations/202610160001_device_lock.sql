-- One device per account (owner decision, 2026-10-16). Applied to production by Claude on 2026-10-16.
--
-- customer_registry.device_id is a random id the app makes per install (not a hardware id and
-- nothing about the phone). The first API call binds it; another id is refused until the admin
-- clears it from the admin panel (/admin). Safe to run more than once.

alter table public.customer_registry
  add column if not exists device_id uuid,
  add column if not exists device_bound_at timestamptz;

comment on column public.customer_registry.device_id is
  'Random per-install id (not hardware). One device per account; the admin clears it to allow a new phone.';

create or replace function public.bind_customer_device(p_device uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_row public.customer_registry%rowtype;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_device is null then
    return 'DEVICE_REQUIRED';
  end if;

  -- Binds only when nothing is bound yet, atomically: two phones racing cannot both win.
  update public.customer_registry
  set device_id = p_device, device_bound_at = now()
  where user_id = v_user_id and device_id is null;

  select * into v_row from public.customer_registry where user_id = v_user_id;
  if not found then
    return 'NOT_REGISTERED';
  end if;
  if v_row.is_active is false then
    return 'SUSPENDED';
  end if;
  if v_row.device_id = p_device then
    return 'OK';
  end if;
  return 'DEVICE_MISMATCH';
end;
$$;

revoke all on function public.bind_customer_device(uuid) from public, anon;
grant execute on function public.bind_customer_device(uuid) to authenticated;
