-- DEAL-01: stage settings in the pipeline editor (colour, and the days without activity
-- after which an open deal in the stage counts as stuck).
--
-- stages.color held free text that no screen wrote. From now on it is a key of the
-- design-system palette (the badge tones, as tags use: src/features/deals/stage-colors.ts),
-- or null for "by the stage's kind". stages.rot_days (null = the default of 14 days,
-- additions spec 22.9; report_stuck_deals compares it with the days since the deal's
-- last activity) gets an upper bound of 365.
--
-- Both checks are added NOT VALID, so adding them never fails on existing rows, and they
-- are validated right away when no existing row breaks them. A NOT VALID check still
-- applies to every later UPDATE of a row: a row that breaks it must have its colour or
-- days fixed before anything else in it can be edited.
-- Safe to run twice.

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'stages_color_token' and conrelid = 'public.stages'::regclass
  ) then
    alter table public.stages add constraint stages_color_token
      check (color is null or color in ('accent', 'success', 'warning', 'danger', 'neutral')) not valid;
  end if;
  if exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'stages_color_token' and conrelid = 'public.stages'::regclass and not convalidated
  ) and not exists (
    select 1 from public.stages where color is not null and color not in ('accent', 'success', 'warning', 'danger', 'neutral')
  ) then
    alter table public.stages validate constraint stages_color_token;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'stages_rot_days_max' and conrelid = 'public.stages'::regclass
  ) then
    alter table public.stages add constraint stages_rot_days_max check (rot_days is null or rot_days <= 365) not valid;
  end if;
  if exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'stages_rot_days_max' and conrelid = 'public.stages'::regclass and not convalidated
  ) and not exists (select 1 from public.stages where rot_days > 365) then
    alter table public.stages validate constraint stages_rot_days_max;
  end if;
end;
$$;
