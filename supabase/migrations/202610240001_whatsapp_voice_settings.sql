-- WhatsApp personal path: customer preferred voice settings (provider, voices).
-- Safe to run more than once.

alter table public.whatsapp_tenant_nodes
  add column if not exists voice_settings jsonb default null;

comment on column public.whatsapp_tenant_nodes.voice_settings is 'Customer selected cloud voice provider and voice IDs';

grant update (voice_settings) on public.whatsapp_tenant_nodes to authenticated;

