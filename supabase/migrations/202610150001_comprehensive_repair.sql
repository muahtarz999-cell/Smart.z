-- Smart.z comprehensive repair (2026-10-15)
--
-- 1. customer_registry.is_active: a way to suspend a customer without deleting the account.
-- 2. WhatsApp personal-path nodes:
--    * claim / release take the caller from auth.uid(); a client can no longer act for another user.
--    * claim picks the first free node from the server's candidate list under a lock (no race).
--    * unfinished reservations expire after 15 minutes so abandoned clicks cannot fill all 5 nodes.
--    * per-customer auto-reply switch, off by default.
-- 3. whatsapp_node_sessions: Baileys session storage for the Render nodes (service role only),
--    so a session survives restarts of Render's ephemeral disk.
-- Safe to run once on production; existing rows are kept.

-- ---------------------------------------------------------------- 1. customer suspension
alter table public.customer_registry
  add column if not exists is_active boolean not null default true;

-- ---------------------------------------------------------------- 2. tenant nodes
alter table public.whatsapp_tenant_nodes
  add column if not exists auto_reply_enabled boolean not null default false;

alter table public.whatsapp_tenant_nodes
  alter column status set default 'pending';

update public.whatsapp_tenant_nodes set status = 'pending' where status = 'assigned';

create or replace function public.set_whatsapp_tenant_nodes_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists whatsapp_tenant_nodes_updated_at on public.whatsapp_tenant_nodes;
create trigger whatsapp_tenant_nodes_updated_at
before update on public.whatsapp_tenant_nodes
for each row execute function public.set_whatsapp_tenant_nodes_updated_at();

-- Clients may read their own row and change only the auto-reply switch and the status.
-- Inserts and deletes go through the functions below.
revoke insert, update, delete on public.whatsapp_tenant_nodes from authenticated;
grant select on public.whatsapp_tenant_nodes to authenticated;
grant update (auto_reply_enabled, status, phone_number, last_status_check) on public.whatsapp_tenant_nodes to authenticated;

drop policy if exists whatsapp_tenant_nodes_insert_own on public.whatsapp_tenant_nodes;
drop policy if exists whatsapp_tenant_nodes_delete_own on public.whatsapp_tenant_nodes;
drop policy if exists whatsapp_tenant_nodes_update_own on public.whatsapp_tenant_nodes;
create policy whatsapp_tenant_nodes_update_own
on public.whatsapp_tenant_nodes
for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

-- Old signatures trusted a caller-supplied user id.
drop function if exists public.claim_whatsapp_cluster_node(uuid, integer, text);
drop function if exists public.release_whatsapp_cluster_node(uuid);
drop function if exists public.get_occupied_whatsapp_nodes();

create or replace function public.claim_whatsapp_cluster_node(p_candidates jsonb)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.whatsapp_tenant_nodes%rowtype;
  v_candidate jsonb;
  v_node_id integer;
  v_inserted public.whatsapp_tenant_nodes%rowtype;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if not exists (
    select 1 from public.customer_registry
    where user_id = v_user_id and is_active
  ) then
    return json_build_object('success', false, 'error', 'CUSTOMER_INACTIVE');
  end if;

  -- One claim at a time across all users: five rows, contention is negligible.
  perform pg_catalog.pg_advisory_xact_lock(hashtext('smartz.whatsapp_tenant_nodes'));

  delete from public.whatsapp_tenant_nodes
  where status = 'pending'
    and updated_at < now() - interval '15 minutes'
    and user_id <> v_user_id;

  select * into v_existing from public.whatsapp_tenant_nodes where user_id = v_user_id;
  if found then
    return json_build_object(
      'success', true, 'node_id', v_existing.node_id, 'node_url', v_existing.node_url,
      'status', v_existing.status, 'is_new', false
    );
  end if;

  for v_candidate in select * from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb))
  loop
    v_node_id := (v_candidate ->> 'id')::integer;
    continue when v_node_id is null or v_node_id < 1 or v_node_id > 5;
    continue when exists (select 1 from public.whatsapp_tenant_nodes where node_id = v_node_id);

    insert into public.whatsapp_tenant_nodes (user_id, node_id, node_url, status)
    values (v_user_id, v_node_id, coalesce(v_candidate ->> 'url', ''), 'pending')
    returning * into v_inserted;

    return json_build_object(
      'success', true, 'node_id', v_inserted.node_id, 'node_url', v_inserted.node_url,
      'status', v_inserted.status, 'is_new', true
    );
  end loop;

  return json_build_object('success', false, 'error', 'ALL_CLUSTER_NODES_OCCUPIED');
end;
$$;

revoke all on function public.claim_whatsapp_cluster_node(jsonb) from public, anon;
grant execute on function public.claim_whatsapp_cluster_node(jsonb) to authenticated;

create or replace function public.release_whatsapp_cluster_node()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_node_id integer;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  delete from public.whatsapp_tenant_nodes
  where user_id = auth.uid()
  returning node_id into v_node_id;
  return v_node_id;
end;
$$;

revoke all on function public.release_whatsapp_cluster_node() from public, anon;
grant execute on function public.release_whatsapp_cluster_node() to authenticated;

-- ---------------------------------------------------------------- 3. node session storage
create table if not exists public.whatsapp_node_sessions (
  node_id integer not null check (node_id between 1 and 5),
  key text not null,
  value jsonb,
  updated_at timestamptz not null default now(),
  primary key (node_id, key)
);

alter table public.whatsapp_node_sessions enable row level security;
revoke all on public.whatsapp_node_sessions from public, anon, authenticated;
grant all on public.whatsapp_node_sessions to service_role;
-- No policies on purpose: only the Render nodes (service role) read or write sessions.
