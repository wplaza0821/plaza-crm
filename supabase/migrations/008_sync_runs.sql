-- 008_sync_runs.sql — record every background sync so the CRM can show freshness
--
-- WHY: the document and QuickBooks syncs ran as cron jobs on one Mac. When that
-- machine was asleep the data silently went stale and nothing in the CRM said
-- so. Each job now writes a row here; the rail footer reads the latest per job
-- and turns amber/red as it ages.
--
-- Also schedules dropbox-docs-sync (the edge-function port of
-- crm_dropbox_docs.py) to run daily on Supabase itself, so it no longer depends
-- on a laptop being open.

create table if not exists sync_runs (
  id           bigserial primary key,
  job          text not null,                 -- 'dropbox_docs' | 'qb_reconcile'
  started_at   timestamptz not null,
  finished_at  timestamptz not null default now(),
  ok           boolean not null,
  stats        jsonb,
  error        text
);
create index if not exists sync_runs_job_idx on sync_runs(job, finished_at desc);

alter table sync_runs enable row level security;
revoke all on sync_runs from anon;
grant select on sync_runs to authenticated;             -- UI reads
-- writes come from edge functions using the service role, which bypasses RLS
drop policy if exists sync_runs_read on sync_runs;
create policy sync_runs_read on sync_runs
  for select to authenticated using (is_allowed_user());

-- ---------------- schedule ----------------
-- pg_cron + pg_net are enabled from the dashboard (Database > Extensions) or here.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The cron trigger authenticates with a shared secret. Store it ONCE in Vault
-- (same value as the SYNC_SECRET function secret):
--   select vault.create_secret('<long-random-string>', 'sync_secret');
--
-- 7:00 AM Miami = 11:00 UTC during daylight time (Mar–Nov), 12:00 UTC in winter.
-- cron runs in UTC and does not follow DST, so this fires at 7am EDT / 6am EST.
select cron.unschedule('dropbox-docs-sync')
 where exists (select 1 from cron.job where jobname = 'dropbox-docs-sync');
select cron.schedule(
  'dropbox-docs-sync',
  '0 11 * * *',
  $$
  select net.http_post(
    url     := 'https://zhxwkntrndaeqtkmbtsh.supabase.co/functions/v1/dropbox-docs-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Sync-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
