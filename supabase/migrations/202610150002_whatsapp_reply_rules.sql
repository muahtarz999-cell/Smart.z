-- WhatsApp personal path: who gets automatic replies, and in what form (2026-10-15).
-- Requires 202610150001. Safe to run more than once.

alter table public.whatsapp_tenant_nodes
  add column if not exists reply_scope text not null default 'all'
    check (reply_scope in ('all', 'allowlist')),
  add column if not exists allowed_numbers text[] not null default '{}',
  add column if not exists voice_reply_mode text not null default 'match'
    check (voice_reply_mode in ('match', 'text', 'voice'));

comment on column public.whatsapp_tenant_nodes.reply_scope is 'all = reply to every 1:1 chat; allowlist = only allowed_numbers';
comment on column public.whatsapp_tenant_nodes.voice_reply_mode is 'match = voice note gets a voice reply, text gets text; text; voice';

-- Customers edit their own reply rules (same row-level policy as auto_reply_enabled).
grant update (reply_scope, allowed_numbers, voice_reply_mode) on public.whatsapp_tenant_nodes to authenticated;
