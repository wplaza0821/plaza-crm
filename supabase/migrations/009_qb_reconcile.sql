-- 009_qb_reconcile.sql — move the QuickBooks reconcile off William's Mac
--
-- WHY: crm_qb_stage_reconcile.py ran as a Hermes cron at 07:15 on one laptop.
-- Asleep laptop = stale A/R with nothing in the CRM saying so, the same failure
-- migration 008 fixed for the Dropbox sync. This schedules the edge-function
-- port (functions/qb-reconcile) and gives it somewhere to keep its OAuth token.
--
-- WHY A TABLE AND NOT A SECRET (the one real difference from dropbox-docs-sync)
-- ---------------------------------------------------------------------------
-- Dropbox refresh tokens are long-lived and static, so DROPBOX_REFRESH_TOKEN
-- can live in a function secret. Intuit ROTATES: a refresh exchange may hand
-- back a new refresh_token, the old one stops working, and the connection dies
-- outright if none is used for 100 days. Function secrets are read-only at
-- runtime, so the token cannot live in one — it has to be written back on every
-- rotation, which means a table.
--
-- prev_refresh_token exists because two runs can overlap (the 7:15 cron and
-- "Sync now"). Whichever rotates second finds its token already retired; it
-- retries with the previous one rather than failing the whole sync. Intuit
-- honours the prior token for a short grace window, which is what makes this
-- work.

create table if not exists qb_tokens (
  realm_id            text primary key,
  refresh_token       text not null,
  prev_refresh_token  text,
  rotated_at          timestamptz not null default now(),
  -- from Intuit's x_refresh_token_expires_in: the hard deadline after which
  -- reconnecting needs a human in a browser. Surfaced in the run report so it
  -- is never discovered by finding a dead sync.
  refresh_expires_at  timestamptz
);

comment on table qb_tokens is
  'QuickBooks OAuth refresh token, rewritten by the qb-reconcile edge function '
  'each time Intuit rotates it. Service role only — never exposed to the app.';

-- No policies are created on purpose: RLS with zero policies denies every
-- non-superuser role, and the edge function uses the service role, which
-- bypasses RLS. The explicit revokes make that intent legible rather than
-- relying on default grants staying tight.
alter table qb_tokens enable row level security;
revoke all on qb_tokens from anon, authenticated;

-- Seed ONCE from the Mac's ~/.env.qbo (that file is the only copy):
--   insert into qb_tokens (realm_id, refresh_token)
--   values ('<QBO_REALM_ID>', '<QBO_REFRESH_TOKEN>')
--   on conflict (realm_id) do update set refresh_token = excluded.refresh_token,
--     prev_refresh_token = null, rotated_at = now();
-- and set the matching function secrets:
--   supabase secrets set --project-ref zhxwkntrndaeqtkmbtsh \
--     QBO_CLIENT_ID=... QBO_CLIENT_SECRET=... QBO_REALM_ID=...

-- ---------------- schedule ----------------
-- Mirrors the Hermes job this replaces: 07:15 weekdays, 15 minutes after the
-- document sync so a deal created by one is visible to the other. cron runs in
-- UTC and does not follow DST, so 11:15 UTC is 7:15 EDT / 6:15 EST — the same
-- drift migration 008 accepted for dropbox-docs-sync.
--
-- Weekdays only, like the original: Plaza does not invoice on weekends and a
-- daily run would only spend the freshness budget for nothing.
select cron.unschedule('qb-reconcile')
 where exists (select 1 from cron.job where jobname = 'qb-reconcile');
select cron.schedule(
  'qb-reconcile',
  '15 11 * * 1-5',
  $$
  select net.http_post(
    url     := 'https://zhxwkntrndaeqtkmbtsh.supabase.co/functions/v1/qb-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Sync-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_secret')
    ),
    body    := '{"apply": true}'::jsonb
  );
  $$
);
