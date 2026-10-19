-- Local draft only. Do NOT apply to Supabase yet.
begin;

alter table public.computer_devices
  add column if not exists pairing_challenge_hash text,
  add column if not exists pairing_expires_at timestamptz;

create unique index if not exists computer_devices_pairing_challenge_hash_uidx
  on public.computer_devices(pairing_challenge_hash)
  where pairing_challenge_hash is not null;

commit;