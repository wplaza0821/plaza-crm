-- 006_qb_open_balance.sql — record QuickBooks open balance alongside billed_to_date
--
-- billed_to_date answers "how much have we invoiced?". It cannot answer "how
-- much do they still owe us?", because an invoice that has been paid and one
-- that has not both count as billed. Those are different questions and the
-- A/R KPI needs the second one:
--
--   contract_value - billed_to_date  = won work NOT YET INVOICED (revenue leak)
--   qb_open_balance                  = invoiced and NOT YET PAID (true A/R)
--
-- crm_qb_stage_reconcile.py already computes both from the same authoritative
-- project-number-matched invoices, so populating this costs nothing extra.
--
-- Both columns are written ONLY from invoices matched by project number. Fuzzy
-- customer-name matches are never allowed to contribute money, because Plaza
-- bills sibling projects under one customer and a name match sweeps in totals
-- that belong to a different deal (see MATCH CONFIDENCE in that script).

alter table deals add column if not exists qb_open_balance numeric;
alter table deals add column if not exists qb_synced_at    timestamptz;

comment on column deals.qb_open_balance is
  'Sum of unpaid balances on project-number-matched QuickBooks invoices. '
  'This is accounts receivable: billed but not yet collected. NULL means QB '
  'has never been reconciled for this deal, which is NOT the same as zero.';
comment on column deals.qb_synced_at is
  'Last time crm_qb_stage_reconcile.py wrote billing figures for this deal. '
  'Distinguishes "reconciled, genuinely owes nothing" from "never checked".';

-- Rebuild deals_value to expose the billing columns the UI needs. The view is
-- select *, so the new columns flow through, but unbilled_value is added here
-- so the client is not left recomputing it from parts.
--
-- DROP then CREATE, not CREATE OR REPLACE: `select d.*` puts the two new
-- columns ahead of the appended contract_value, and replace cannot renumber
-- existing view columns ("cannot change name of view column"). The whole
-- migration runs in one transaction, so readers see the old view or the new
-- one, never a missing one.
drop view if exists deals_value;
create view deals_value as
select d.*,
       deal_contract_value(d) as contract_value,
       greatest(deal_contract_value(d) - coalesce(d.billed_to_date, 0), 0)
         as unbilled_value,
       (d.rate is not null and d.rate_unit = 'month' and d.term_months is null)
         as term_unknown,
       ('hourly' = any(d.fee_flags)) as has_hourly_scope
from deals d;
