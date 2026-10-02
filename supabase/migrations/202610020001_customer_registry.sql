create table if not exists public.customer_registry (
  user_id uuid primary key references auth.users(id) on delete cascade,
  account_status text not null default 'pending'
    check (account_status in ('pending', 'active', 'suspended', 'disabled')),
  start_date date not null default current_date,
  end_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_customer_registry_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists customer_registry_updated_at on public.customer_registry;
create trigger customer_registry_updated_at
before update on public.customer_registry
for each row execute function public.set_customer_registry_updated_at();

create or replace function public.create_pending_customer_registry_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.customer_registry (user_id, account_status, start_date)
  values (new.id, 'pending', current_date)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function public.create_pending_customer_registry_entry() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_customer_registry on auth.users;
create trigger on_auth_user_created_customer_registry
after insert on auth.users
for each row execute function public.create_pending_customer_registry_entry();

insert into public.customer_registry (user_id, account_status, start_date)
select id, 'pending', current_date
from auth.users
on conflict (user_id) do nothing;

alter table public.customer_registry enable row level security;
revoke all on public.customer_registry from public, anon, authenticated;
grant select on public.customer_registry to authenticated;

drop policy if exists customer_registry_select_own on public.customer_registry;
create policy customer_registry_select_own
on public.customer_registry
for select
to authenticated
using (user_id = (select auth.uid()));
