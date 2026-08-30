-- 003_fee_model.sql — HubSpot-style money model for Plaza CRM
-- Ruling (William, 2026-08-09):
--   1. recurring deals INCLUDE expected term  -> contract_value = rate * term_months
--   2. multi-line proposals INCLUDE options   -> contract_value = base + options_nte
--   3. missing PDFs resolved from .docx       -> no nulls left for that reason
--
-- Why: a single scalar `amount` cannot represent a Plaza proposal. It was holding
-- QuickBooks *billed* dollars for some rows, monthly *rates* for others, and NULL
-- for 22 deals that had a real signed fee. Keep source-of-truth columns separate
-- and let the UI disclose which number it is showing.

alter table deals add column if not exists proposal_fee    numeric;  -- one-time $ from the proposal PDF/DOCX
alter table deals add column if not exists rate            numeric;  -- recurring rate, NEVER summed directly
alter table deals add column if not exists rate_unit       text;     -- 'month' | 'project' | 'letter'
alter table deals add column if not exists term_months     integer;  -- expected term; NULL = unknown, do not guess
alter table deals add column if not exists options_nte     numeric;  -- not-to-exceed / elective scope
alter table deals add column if not exists billed_to_date  numeric;  -- from QuickBooks, never mixed with fee
alter table deals add column if not exists fee_flags       text[] default '{}'; -- hourly, included, nte, needs_ocr...
alter table deals add column if not exists fee_source      text;     -- filename the fee was parsed from
alter table deals add column if not exists fee_verified_at timestamptz;

-- contract_value: the ONE summable number, computed per William's rulings.
-- recurring with a known term -> rate * term_months ; unknown term -> excluded (NULL)
-- so an unknown duration can never silently inflate the pipeline.
create or replace function deal_contract_value(d deals) returns numeric
language sql immutable as $$
  select coalesce(d.proposal_fee, 0)
       + coalesce(d.options_nte, 0)
       + case
           when d.rate is not null and d.rate_unit = 'month' and d.term_months is not null
             then d.rate * d.term_months
           else 0
         end
$$;

-- Flag rows whose value is knowingly incomplete so the UI can mark them.
create or replace view deals_value as
select d.*,
       deal_contract_value(d) as contract_value,
       (d.rate is not null and d.rate_unit = 'month' and d.term_months is null)
         as term_unknown,
       ('hourly' = any(d.fee_flags)) as has_hourly_scope
from deals d;

comment on column deals.rate is
  'Recurring rate. NEVER SUM() this column — use deals_value.contract_value.';
comment on column deals.term_months is
  'Expected term in months, taken from the proposal text. NULL means the document '
  'states no duration; leave NULL rather than assuming 12.';
comment on column deals.amount is
  'LEGACY. Was a mix of QuickBooks billed dollars, monthly rates and NULLs. '
  'Superseded by proposal_fee / rate / options_nte / billed_to_date.';
