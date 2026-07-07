-- Per-rule Pipedrive lead visibility.
--   pd_visibility  'all'   (default) — whole company sees the lead (visible_to=7 / account default)
--                  'owner'           — only the assigned owner + Pipedrive admins see it (visible_to=1)
-- Pipedrive leads have no "followers", so arbitrary multi-user visibility is not
-- possible for a lead — only owner-only vs company-wide (or a visibility group).
-- process-lead sets visible_to=1 on the created lead when pd_visibility='owner'.
alter table public.routing_rules
  add column if not exists pd_visibility text not null default 'all';
