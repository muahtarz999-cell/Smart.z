-- AI receptionist (owner request 2026-10-22): answers phone calls forwarded to a
-- local SIP provider number, and WhatsApp calls on the Meta business number.
-- All access goes through the server (service role); customers never read these
-- tables directly. Safe to run more than once.
begin;

create table if not exists public.ai_receptionist_settings (
  user_id uuid primary key references public.customer_registry(user_id) on delete cascade,
  enabled boolean not null default false,
  whatsapp_enabled boolean not null default false,
  owner_name text check (owner_name is null or char_length(owner_name) <= 60),
  greeting text check (greeting is null or char_length(greeting) <= 300),
  knowledge text check (knowledge is null or char_length(knowledge) <= 4000),
  vip_numbers text[] not null default '{}',
  transfer_number text check (transfer_number is null or transfer_number ~ '^[0-9]{8,15}$'),
  updated_at timestamptz not null default now()
);

-- Which called number belongs to which customer. Phone numbers are assigned by the
-- admin (the provider number of that customer); the WhatsApp number is added when
-- the customer turns WhatsApp calls on. One number, one customer.
create table if not exists public.ai_receptionist_numbers (
  number text primary key check (number ~ '^[0-9]{8,15}$'),
  user_id uuid not null references public.customer_registry(user_id) on delete cascade,
  channel text not null check (channel in ('phone', 'whatsapp')),
  created_at timestamptz not null default now()
);
create index if not exists ai_receptionist_numbers_user_idx on public.ai_receptionist_numbers(user_id);

-- One row per answered call: the summary and the recorded message, never the audio.
create table if not exists public.ai_call_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.customer_registry(user_id) on delete cascade,
  call_id text not null unique check (char_length(call_id) <= 120),
  channel text not null check (channel in ('phone', 'whatsapp')),
  caller_number text,
  caller_name text,
  summary text,
  message text,
  callback_number text,
  urgent boolean not null default false,
  transferred boolean not null default false,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists ai_call_logs_user_created_idx on public.ai_call_logs(user_id, created_at desc);

alter table public.ai_receptionist_settings enable row level security;
alter table public.ai_receptionist_numbers enable row level security;
alter table public.ai_call_logs enable row level security;
revoke all on public.ai_receptionist_settings, public.ai_receptionist_numbers, public.ai_call_logs from public, anon, authenticated;
grant all on public.ai_receptionist_settings, public.ai_receptionist_numbers, public.ai_call_logs to service_role;

commit;
