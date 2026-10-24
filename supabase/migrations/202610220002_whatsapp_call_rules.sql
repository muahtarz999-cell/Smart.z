-- WhatsApp calls: reject automatically and send a message (owner request 2026-10-22).
-- The node asks the app on every incoming WhatsApp call (/api/whatsapp/cluster/call);
-- the app answers from these columns. Requires 202610150002. Safe to run more than once.
begin;

alter table public.whatsapp_tenant_nodes
  add column if not exists call_reject_enabled boolean not null default false,
  add column if not exists call_reject_message text
    check (call_reject_message is null or char_length(call_reject_message) <= 300),
  add column if not exists driving_until timestamptz;

comment on column public.whatsapp_tenant_nodes.call_reject_enabled is 'Reject incoming WhatsApp calls and send call_reject_message';
comment on column public.whatsapp_tenant_nodes.call_reject_message is 'Message sent to a rejected caller; null = default text';
comment on column public.whatsapp_tenant_nodes.driving_until is 'Driving mode is on until this time: calls are rejected with the driving message';

-- Customers edit their own call rules (same row-level policy as the reply rules).
grant update (call_reject_enabled, call_reject_message, driving_until) on public.whatsapp_tenant_nodes to authenticated;

commit;
