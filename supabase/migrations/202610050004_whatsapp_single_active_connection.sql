with ranked_connections as (
  select
    id,
    row_number() over (
      partition by user_id
      order by created_at desc, id desc
    ) as position
  from public.whatsapp_connections
  where status = 'connected'
)
update public.whatsapp_connections as connection
set status = 'replaced'
from ranked_connections
where connection.id = ranked_connections.id
  and ranked_connections.position > 1;

create unique index if not exists whatsapp_connections_one_active_per_user_key
  on public.whatsapp_connections (user_id)
  where status = 'connected';

create or replace function public.activate_whatsapp_connection(
  p_waba_id text,
  p_phone_number_id text,
  p_display_phone_number text,
  p_verified_name text,
  p_access_token text,
  p_expires_at timestamptz
)
returns table (
  connection_id uuid,
  display_phone_number text,
  verified_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_connection_id uuid;
  v_connection_user_id uuid;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_waba_id is null or p_waba_id !~ '^[0-9]+$'
    or p_phone_number_id is null or p_phone_number_id !~ '^[0-9]+$'
    or p_access_token is null or length(p_access_token) = 0 then
    raise exception 'INVALID_CONNECTION_DATA';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text, 0)
  );

  select connection.id, connection.user_id
    into v_connection_id, v_connection_user_id
  from public.whatsapp_connections as connection
  where connection.phone_number_id = p_phone_number_id
  for update;

  if v_connection_id is not null and v_connection_user_id <> v_user_id then
    raise exception 'PHONE_NUMBER_IN_USE';
  end if;

  if v_connection_id is null then
    insert into public.whatsapp_connections (
      user_id,
      waba_id,
      phone_number_id,
      display_phone_number,
      verified_name,
      status
    )
    values (
      v_user_id,
      p_waba_id,
      p_phone_number_id,
      p_display_phone_number,
      p_verified_name,
      'pending'
    )
    returning id into v_connection_id;
  else
    update public.whatsapp_connections as connection
    set
      waba_id = p_waba_id,
      display_phone_number = p_display_phone_number,
      verified_name = p_verified_name
    where connection.id = v_connection_id;
  end if;

  insert into public.whatsapp_connection_secrets (
    connection_id,
    user_id,
    access_token,
    expires_at
  )
  values (
    v_connection_id,
    v_user_id,
    p_access_token,
    p_expires_at
  )
  on conflict (connection_id) do update
  set
    user_id = excluded.user_id,
    access_token = excluded.access_token,
    expires_at = excluded.expires_at;

  update public.whatsapp_connections as connection
  set status = 'replaced'
  where connection.user_id = v_user_id
    and connection.status = 'connected'
    and connection.id <> v_connection_id;

  delete from public.whatsapp_connection_secrets as secret
  where secret.user_id = v_user_id
    and secret.connection_id <> v_connection_id;

  update public.whatsapp_connections as connection
  set status = 'connected'
  where connection.id = v_connection_id
    and connection.user_id = v_user_id;

  return query
  select connection.id, connection.display_phone_number, connection.verified_name
  from public.whatsapp_connections as connection
  where connection.id = v_connection_id;
end;
$$;

revoke all on function public.activate_whatsapp_connection(
  text, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.activate_whatsapp_connection(
  text, text, text, text, text, timestamptz
) to authenticated;
