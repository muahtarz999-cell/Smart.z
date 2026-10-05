create table if not exists public.whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.customer_registry(user_id) on delete cascade,
  waba_id text not null,
  phone_number_id text,
  display_phone_number text,
  verified_name text,
  status text not null default 'connected',
  created_at timestamptz not null default now()
);

alter table public.whatsapp_connections
  add column if not exists waba_id text,
  add column if not exists connection_type text default 'meta',
  add column if not exists phone_number_id text,
  add column if not exists display_phone_number text,
  add column if not exists verified_name text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists status text not null default 'connected';

alter table public.whatsapp_connections
  alter column connection_type set default 'meta';

create unique index if not exists whatsapp_connections_phone_number_id_key
  on public.whatsapp_connections (phone_number_id)
  where phone_number_id is not null;
create unique index if not exists whatsapp_connections_id_user_id_key
  on public.whatsapp_connections (id, user_id);

alter table public.whatsapp_connections enable row level security;
revoke all on public.whatsapp_connections from public, anon, authenticated;
grant select, insert, delete on public.whatsapp_connections to authenticated;
grant all on public.whatsapp_connections to service_role;

drop policy if exists whatsapp_connections_user_scope on public.whatsapp_connections;
create policy whatsapp_connections_user_scope
on public.whatsapp_connections
as restrictive
for all
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists whatsapp_connections_select_own on public.whatsapp_connections;
create policy whatsapp_connections_select_own
on public.whatsapp_connections
for select
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists whatsapp_connections_insert_own on public.whatsapp_connections;
create policy whatsapp_connections_insert_own
on public.whatsapp_connections
for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists whatsapp_connections_delete_own on public.whatsapp_connections;
create policy whatsapp_connections_delete_own
on public.whatsapp_connections
for delete
to authenticated
using (user_id = (select auth.uid()));

create table if not exists public.whatsapp_connection_secrets (
  connection_id uuid primary key,
  user_id uuid not null,
  access_token text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (connection_id, user_id)
    references public.whatsapp_connections(id, user_id)
    on delete cascade
);

alter table public.whatsapp_connection_secrets enable row level security;
revoke all on public.whatsapp_connection_secrets from public, anon, authenticated;
grant insert, delete on public.whatsapp_connection_secrets to authenticated;
grant all on public.whatsapp_connection_secrets to service_role;

drop policy if exists whatsapp_connection_secrets_user_scope on public.whatsapp_connection_secrets;
create policy whatsapp_connection_secrets_user_scope
on public.whatsapp_connection_secrets
as restrictive
for all
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists whatsapp_connection_secrets_insert_own on public.whatsapp_connection_secrets;
create policy whatsapp_connection_secrets_insert_own
on public.whatsapp_connection_secrets
for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists whatsapp_connection_secrets_delete_own on public.whatsapp_connection_secrets;
create policy whatsapp_connection_secrets_delete_own
on public.whatsapp_connection_secrets
for delete
to authenticated
using (user_id = (select auth.uid()));

do $$
begin
  if to_regclass('private.whatsapp_connection_secrets') is not null then
    execute '
      insert into public.whatsapp_connection_secrets
        (connection_id, user_id, access_token, expires_at)
      select connection_id, user_id, access_token, expires_at
      from private.whatsapp_connection_secrets
      on conflict (connection_id) do nothing
    ';
  end if;
end;
$$;
