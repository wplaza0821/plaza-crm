-- 004_deal_documents.sql — attach Dropbox proposals to deals (2026-08-10)
--
-- WHY A TABLE AND NOT COLUMNS ON `deals`:
--   The Dropbox scan found 152 proposal documents across 75 deals — several per
--   deal (draft + revised + signed, plus T&C attachments and subconsultant
--   proposals). Columns on `deals` would hold one and discard 77.
--
-- LINK STRATEGY — read before "fixing" the url column:
--   The Plaza Dropbox app (ID 6649875) is granted files.metadata.read and
--   files.content.read ONLY. Both sharing endpoints fail:
--     sharing/create_shared_link_with_settings -> 400 missing scope sharing.write
--     sharing/list_shared_links                -> 400 missing scope sharing.read
--   files/get_temporary_link works but expires in ~4 hours, so it cannot be
--   stored. We therefore store a deterministic, non-expiring Dropbox web URL
--   built from the file path, which needs no sharing scope and resolves for any
--   signed-in member of the Plaza team (William, Noel, staff — the actual
--   audience). `link_kind` records which flavour each row holds so that if
--   sharing.write is later enabled in the App Console, rows can be upgraded in
--   place without a re-scan and without guessing.

create table if not exists deal_documents (
  id           bigserial primary key,
  deal_id      bigint not null references deals(id) on delete cascade,
  -- Dropbox identity. path_lower is the stable key: Dropbox lowercases paths
  -- and a file keeps its path across metadata refreshes, so re-running the sync
  -- updates instead of duplicating.
  path_lower   text not null,
  path_display text not null,
  file_name    text not null,
  url          text not null,
  link_kind    text not null default 'web_path'
               check (link_kind in ('web_path','shared_link')),
  size_bytes   bigint,
  modified_at  timestamptz,
  -- Classification produced by crm_dropbox_docs.py
  is_primary   boolean not null default false,  -- the client-facing proposal
  is_signed    boolean not null default false,  -- filename says SIGNED/EXECUTED
  doc_kind     text,                            -- proposal | agreement | t&c | other
  source_year  text,                            -- '2026' | '2025'
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (deal_id, path_lower)
);

create index if not exists deal_documents_deal_idx on deal_documents(deal_id);
create index if not exists deal_documents_primary_idx
  on deal_documents(deal_id) where is_primary;

-- Exactly one primary per deal. A partial unique index is the only way to
-- enforce "at most one true" without blocking the many false rows.
create unique index if not exists deal_documents_one_primary
  on deal_documents(deal_id) where is_primary;

alter table deal_documents enable row level security;

-- Same allow-list gate as deals/activities (see 002_allowlist.sql). anon gets a
-- hard permission denied, not merely an empty result set.
revoke all on deal_documents from anon;
grant select, insert, update, delete on deal_documents to authenticated;
grant usage, select on sequence deal_documents_id_seq to authenticated;

drop policy if exists docs_auth_all on deal_documents;
create policy docs_auth_all on deal_documents
  for all to authenticated
  using (is_allowed_user()) with check (is_allowed_user());

-- Convenience view for the UI: one row per deal with the primary proposal
-- surfaced plus a total count, so the board/table can show a badge without
-- fetching every document.
create or replace view deal_primary_doc
with (security_invoker = on) as
select
  d.id                as deal_id,
  count(dd.id)        as doc_count,
  count(dd.id) filter (where dd.is_signed) as signed_count,
  max(dd.file_name)   filter (where dd.is_primary) as primary_name,
  max(dd.url)         filter (where dd.is_primary) as primary_url,
  bool_or(dd.is_signed) filter (where dd.is_primary) as primary_signed
from deals d
left join deal_documents dd on dd.deal_id = d.id
group by d.id;

grant select on deal_primary_doc to authenticated;
revoke all on deal_primary_doc from anon;
