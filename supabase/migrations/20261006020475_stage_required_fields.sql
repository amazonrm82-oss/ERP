-- =============================================================================
-- DEAL-05: built-in deal fields required to enter a stage
-- =============================================================================
-- Owner, 18 October 2026, answer (א): the amount, the expected close date and the contact may be made required per
-- stage. FLD-09 already makes custom fields required by a stage (field_definitions.condition); this adds the three
-- built-in fields, stored on the stage itself:
-- * stages.required_fields: the keys of the built-in fields a deal must hold to enter the stage, from the closed list
--   amount | expected_close_date | contact_id (mirrored by STAGE_REQUIRED_FIELDS in src/features/deals/stage-required.ts,
--   a unit test reads this file). Empty = none (every stage today). Written with the stage (owners/admins, stages
--   policies and table grants unchanged); audited with the stage.
-- * App-only, like FLD-09's "require" (owner, 14 October 2026): every move by hand (board, card menu, table cell,
--   stage menu, won window, cleanup and forecast lists) asks for the missing values and saves them with the move; a bulk
--   move skips the deal ("חסר שדה חובה: …"); automations, imports and server writers are never refused, so a rule or
--   an import never stops half way on a stage setting.
-- Additive only (a constant default adds the column without rewriting rows). Safe to run twice.

alter table public.stages add column if not exists required_fields text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stages_required_fields_known' and conrelid = 'public.stages'::regclass) then
    alter table public.stages add constraint stages_required_fields_known
      check (required_fields <@ array['amount', 'expected_close_date', 'contact_id']::text[]);
  end if;
end;
$$;

notify pgrst, 'reload schema';
