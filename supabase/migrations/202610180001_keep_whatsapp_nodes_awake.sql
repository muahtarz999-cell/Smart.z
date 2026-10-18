-- Keeps the Render WhatsApp nodes of linked customers awake.
--
-- A free Render service sleeps after 15 minutes without requests; while it
-- sleeps the WhatsApp socket is closed, incoming messages are not collected
-- and voice-note retries go unanswered. Every 10 minutes this knocks on
-- /healthz of each node that has a connected customer. Free nodes nobody
-- uses keep sleeping, so they do not spend Render's monthly free hours.
--
-- Stop:  select cron.unschedule('keep-whatsapp-nodes-awake');

create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.keep_whatsapp_nodes_awake()
returns integer
language plpgsql
security definer
set search_path = public, net
as $$
declare
  node record;
  knocked integer := 0;
begin
  for node in
    select distinct rtrim(node_url, '/') as url
    from public.whatsapp_tenant_nodes
    where status = 'connected' and node_url like 'https://%'
  loop
    perform net.http_get(url := node.url || '/healthz', timeout_milliseconds := 60000);
    knocked := knocked + 1;
  end loop;
  return knocked;
end;
$$;

revoke all on function public.keep_whatsapp_nodes_awake() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'keep-whatsapp-nodes-awake';
select cron.schedule('keep-whatsapp-nodes-awake', '*/10 * * * *', $$select public.keep_whatsapp_nodes_awake()$$);
