-- 007_merge_lead_into_proposal_sent.sql — collapse 'Lead' into 'Proposal Sent'
-- Ruling (William, 2026-08-30): they are the same thing. Plaza does not open a
-- project until a proposal goes out, so there is no period during which a deal
-- exists but no proposal has been sent. 'Lead' described a state that cannot
-- occur.
--
-- Same reasoning as 005: a stage should mark a position in the sales motion, not
-- a fact better stored elsewhere. Two stages that always coincide are one stage.
--
-- proposal_sent_date is deliberately LEFT NULL on the moved rows. Some of them
-- genuinely have no recorded send date, and inventing one would fabricate
-- business history — a null reads as "date unknown", which is true. It affects
-- display only; `overdue` keys off last_contact_date, not this column.
--
-- The column default must move too, or every new deal would be created directly
-- into a stage the pipeline no longer shows.

alter table deals alter column stage set default 'Proposal Sent';

with moved as (
  update deals
     set stage = 'Proposal Sent'
   where stage = 'Lead'
  returning id
)
insert into activities (deal_id, kind, summary, occurred_at)
select id,
       'stage_change',
       'Lead -> Proposal Sent (stages merged; a deal exists only once a proposal is sent)',
       now()
  from moved;
