-- 005_retire_won_pending_payment.sql — collapse 'Won-Pending Payment' into 'Won'
-- Ruling (William, 2026-08-30): a deal that has been won is Won. Whether the
-- invoice has cleared is a billing fact, not a pipeline position.
--
-- Why the stage was a mistake: it forced a deal to be either won or paid but
-- never both, so the same dollars sat in the open pipeline, in Won and in A/R
-- at once (the KPI double-count documented in index.html kpis()).
-- A/R is now derived from billing instead: a Won deal whose contract value
-- exceeds billed_to_date is outstanding. No stage required.
--
-- `stage` is free text with no check constraint, so this is a plain UPDATE.
-- updated_at is maintained by trg_deals_touch; do not set it by hand.
-- Idempotent: a second run matches no rows, so it logs no activities either.

with moved as (
  update deals
     set stage = 'Won'
   where stage = 'Won-Pending Payment'
  returning id
)
insert into activities (deal_id, kind, summary, occurred_at)
select id,
       'stage_change',
       'Won-Pending Payment -> Won (stage retired; A/R now tracked via billed_to_date)',
       now()
  from moved;
