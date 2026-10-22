-- Several customers per WhatsApp node (owner request 2026-10-22).
-- A node hosts up to RENDER_SERVER_<N>_SLOTS sessions (set in the app); each
-- customer owns one (node_id, slot). Existing rows become slot 0, which is the
-- session layout from before, so linked customers keep working unchanged.
-- Requires 202610150001. Safe to run more than once.
begin;

alter table public.whatsapp_tenant_nodes
  add column if not exists slot integer not null default 0;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_tenant_nodes'::regclass and conname = 'whatsapp_tenant_nodes_slot_check'
  ) then
    alter table public.whatsapp_tenant_nodes
      add constraint whatsapp_tenant_nodes_slot_check check (slot between 0 and 19);
  end if;
end;
$migration$;

-- One customer per (node, slot) instead of one customer per node.
drop index if exists public.whatsapp_tenant_nodes_node_id_key;
create unique index if not exists whatsapp_tenant_nodes_node_slot_key
  on public.whatsapp_tenant_nodes (node_id, slot);

-- p_candidates: [{ "id": 1, "url": "...", "slots": 8 }, ...] in order of preference
-- (awake nodes first). The first free slot of the first node with room wins.
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
  v_slots integer;
  v_slot integer;
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

  perform pg_catalog.pg_advisory_xact_lock(hashtext('smartz.whatsapp_tenant_nodes'));

  delete from public.whatsapp_tenant_nodes
  where status = 'pending'
    and updated_at < now() - interval '15 minutes'
    and user_id <> v_user_id;

  select * into v_existing from public.whatsapp_tenant_nodes where user_id = v_user_id;
  if found then
    return json_build_object(
      'success', true, 'node_id', v_existing.node_id, 'slot', v_existing.slot, 'node_url', v_existing.node_url,
      'status', v_existing.status, 'is_new', false
    );
  end if;

  for v_candidate in select * from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb))
  loop
    v_node_id := (v_candidate ->> 'id')::integer;
    continue when v_node_id is null or v_node_id < 1 or v_node_id > 5;
    v_slots := least(greatest(coalesce((v_candidate ->> 'slots')::integer, 1), 1), 20);

    select candidate_slot into v_slot
    from pg_catalog.generate_series(0, v_slots - 1) as candidate_slot
    where not exists (
      select 1 from public.whatsapp_tenant_nodes t
      where t.node_id = v_node_id and t.slot = candidate_slot
    )
    order by candidate_slot
    limit 1;
    continue when v_slot is null;

    insert into public.whatsapp_tenant_nodes (user_id, node_id, slot, node_url, status)
    values (v_user_id, v_node_id, v_slot, coalesce(v_candidate ->> 'url', ''), 'pending')
    returning * into v_inserted;

    return json_build_object(
      'success', true, 'node_id', v_inserted.node_id, 'slot', v_inserted.slot, 'node_url', v_inserted.node_url,
      'status', v_inserted.status, 'is_new', true
    );
  end loop;

  return json_build_object('success', false, 'error', 'ALL_CLUSTER_NODES_OCCUPIED');
end;
$$;

revoke all on function public.claim_whatsapp_cluster_node(jsonb) from public, anon;
grant execute on function public.claim_whatsapp_cluster_node(jsonb) to authenticated;

-- Frees the caller's (node, slot) and says which one, so the app wipes only that session.
create or replace function public.release_whatsapp_cluster_slot()
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_node_id integer;
  v_slot integer;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  delete from public.whatsapp_tenant_nodes
  where user_id = auth.uid()
  returning node_id, slot into v_node_id, v_slot;
  if v_node_id is null then
    return json_build_object('node_id', null, 'slot', null);
  end if;
  return json_build_object('node_id', v_node_id, 'slot', v_slot);
end;
$$;

revoke all on function public.release_whatsapp_cluster_slot() from public, anon;
grant execute on function public.release_whatsapp_cluster_slot() to authenticated;

commit;
