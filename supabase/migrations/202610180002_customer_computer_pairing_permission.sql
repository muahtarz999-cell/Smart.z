alter table public.customer_registry
  add column if not exists allow_computer_pairing boolean not null default false;

comment on column public.customer_registry.allow_computer_pairing is
  'Controls whether this customer may create a new computer pairing. Defaults to false (denied).';
