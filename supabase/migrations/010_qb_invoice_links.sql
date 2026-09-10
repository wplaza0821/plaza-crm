-- 010_qb_invoice_links.sql — manual invoice → deal overrides for the QB reconcile
--
-- WHY THIS EXISTS (the Terrazas case, 2026-09-10):
--   The CRM tracks "Terrazas Aquatic engineering" as project 26014 and reported
--   it Won-but-never-invoiced. It had in fact been billed and paid — $13,000 on
--   invoices 5755 and 5811 — but both line descriptions read "Proposal 26011",
--   because the invoice was written against the sibling restoration proposal
--   number. The matcher did exactly what the invoice text told it and credited
--   the money to deal 26011, whose reported $37,800 billed / $12,400 open is
--   the two projects' invoices added together.
--
-- WHY NOT A DEAL-LEVEL ALIAS ("deal 26014 also answers to 26011"):
--   It would be wrong here. Invoices 5743 and 5818 genuinely belong to 26011
--   and 5755/5811 do not; an alias cannot tell them apart because all four
--   carry the same number. The mismatch is per invoice, so the override has to
--   be per invoice.
--
-- WHY NOT "just fix QuickBooks":
--   Those invoices are issued, sent and paid. Reissuing paid invoices to make a
--   matcher happy is worse bookkeeping than recording the correction here.
--
-- SEMANTICS:
--   deal_id NOT NULL -> this invoice belongs to that deal, overriding whatever
--                       project number its lines cite. Treated as CONFIDENT:
--                       a human said so, which outranks parsed text.
--   deal_id NULL     -> this invoice belongs to no CRM deal on purpose (a fee
--                       with no project, a retainer, a write-off). It stops
--                       appearing in the unmapped list instead of being
--                       re-reported every weekday forever.

create table if not exists qb_invoice_links (
  -- QuickBooks' own Invoice.Id — immutable. DocNumber is what humans read but
  -- it is editable in QuickBooks, so it is stored for display only.
  qb_invoice_id text primary key,
  doc_number    text,
  deal_id       bigint references deals(id) on delete cascade,
  reason        text,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists qb_invoice_links_deal_idx
  on qb_invoice_links(deal_id) where deal_id is not null;

alter table qb_invoice_links enable row level security;

-- Same allow-list gate as deals/activities (002_allowlist.sql).
revoke all on qb_invoice_links from anon;
grant select, insert, update, delete on qb_invoice_links to authenticated;

drop policy if exists qb_invoice_links_auth_all on qb_invoice_links;
create policy qb_invoice_links_auth_all on qb_invoice_links
  for all to authenticated
  using (is_allowed_user()) with check (is_allowed_user());
