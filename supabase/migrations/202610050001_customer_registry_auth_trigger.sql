create table if not exists public.customer_registry (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.customer_registry
  add column if not exists created_at timestamptz not null default now();

alter table public.customer_registry
  drop column if exists account_status;

drop trigger if exists on_auth_user_created_customer_registry on auth.users;
drop function if exists public.create_pending_customer_registry_entry();

create or replace function public.create_customer_registry_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.customer_registry (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function public.create_customer_registry_entry() from public, anon, authenticated;

create trigger on_auth_user_created_customer_registry
after insert on auth.users
for each row execute function public.create_customer_registry_entry();

alter table public.customer_registry enable row level security;
revoke all on public.customer_registry from public, anon, authenticated;
grant select on public.customer_registry to authenticated;

drop policy if exists customer_registry_select_own on public.customer_registry;
create policy customer_registry_select_own
on public.customer_registry
for select
to authenticated
using (user_id = (select auth.uid()));
