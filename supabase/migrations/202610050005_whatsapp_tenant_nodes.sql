-- Migration: WhatsApp Cluster Tenant Node Allocations
-- Guarantees 1:1 tenant-to-node isolation for the 5 Render Baileys instances.

create table if not exists public.whatsapp_tenant_nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.customer_registry(user_id) on delete cascade,
  node_id integer not null check (node_id between 1 and 5),
  node_url text not null,
  status text not null default 'assigned', -- 'assigned', 'connecting', 'connected', 'disconnected'
  phone_number text,
  last_status_check timestamptz default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Constraint: Only one node per user
create unique index if not exists whatsapp_tenant_nodes_user_id_key
  on public.whatsapp_tenant_nodes (user_id);

-- Constraint: Only one active user per node (Strict Tenant Isolation)
create unique index if not exists whatsapp_tenant_nodes_node_id_key
  on public.whatsapp_tenant_nodes (node_id);

-- Row Level Security
alter table public.whatsapp_tenant_nodes enable row level security;
revoke all on public.whatsapp_tenant_nodes from public, anon, authenticated;
grant select, insert, delete, update on public.whatsapp_tenant_nodes to authenticated;
grant all on public.whatsapp_tenant_nodes to service_role;

-- Restrictive user policy: users can only access their own assigned node
drop policy if exists whatsapp_tenant_nodes_user_scope on public.whatsapp_tenant_nodes;
create policy whatsapp_tenant_nodes_user_scope
on public.whatsapp_tenant_nodes
as restrictive
for all
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

-- Read own policy
drop policy if exists whatsapp_tenant_nodes_select_own on public.whatsapp_tenant_nodes;
create policy whatsapp_tenant_nodes_select_own
on public.whatsapp_tenant_nodes
for select
to authenticated
using (user_id = (select auth.uid()));

-- Insert own policy
drop policy if exists whatsapp_tenant_nodes_insert_own on public.whatsapp_tenant_nodes;
create policy whatsapp_tenant_nodes_insert_own
on public.whatsapp_tenant_nodes
for insert
to authenticated
with check (user_id = (select auth.uid()));

-- Delete own policy
drop policy if exists whatsapp_tenant_nodes_delete_own on public.whatsapp_tenant_nodes;
create policy whatsapp_tenant_nodes_delete_own
on public.whatsapp_tenant_nodes
for delete
to authenticated
using (user_id = (select auth.uid()));

-- Atomic Helper: Get list of currently occupied node IDs
create or replace function public.get_occupied_whatsapp_nodes()
returns table(node_id integer)
language sql
security definer
as $$
  select node_id from public.whatsapp_tenant_nodes;
$$;
grant execute on function public.get_occupied_whatsapp_nodes() to authenticated, service_role;

-- Atomic Helper: Reserve an available node for a user
create or replace function public.claim_whatsapp_cluster_node(p_user_id uuid, p_target_node_id integer, p_node_url text)
returns json
language plpgsql
security definer
as $$
declare
  existing_record record;
  assigned_record record;
begin
  -- 1. Check if user already has an assigned node
  select * into existing_record from public.whatsapp_tenant_nodes where user_id = p_user_id;
  if found then
    return json_build_object(
      'success', true,
      'node_id', existing_record.node_id,
      'node_url', existing_record.node_url,
      'status', existing_record.status,
      'is_new', false
    );
  end if;

  -- 2. Check if the target node is already claimed by someone else
  select * into assigned_record from public.whatsapp_tenant_nodes where node_id = p_target_node_id;
  if found then
    return json_build_object('success', false, 'error', 'NODE_ALREADY_TAKEN');
  end if;

  -- 3. Atomically insert and assign
  insert into public.whatsapp_tenant_nodes (user_id, node_id, node_url, status)
  values (p_user_id, p_target_node_id, p_node_url, 'assigned')
  returning * into existing_record;

  return json_build_object(
    'success', true,
    'node_id', existing_record.node_id,
    'node_url', existing_record.node_url,
    'status', existing_record.status,
    'is_new', true
  );
end;
$$;
grant execute on function public.claim_whatsapp_cluster_node(uuid, integer, text) to authenticated, service_role;

-- Atomic Helper: Release node on disconnect/unbind
create or replace function public.release_whatsapp_cluster_node(p_user_id uuid)
returns boolean
language plpgsql
security definer
as $$
begin
  delete from public.whatsapp_tenant_nodes where user_id = p_user_id;
  return true;
end;
$$;
grant execute on function public.release_whatsapp_cluster_node(uuid) to authenticated, service_role;

