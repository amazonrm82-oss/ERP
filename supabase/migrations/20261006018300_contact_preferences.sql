-- =============================================================================
-- A contact's preferred language and preferred channel (CON-10)
-- =============================================================================
-- * contacts.preferred_locale (since migration 0002, no UI until now) is null or
--   one of a closed list: he, ar, en, ru, am, fr, es. Mirrored by
--   CONTACT_LOCALES in src/features/contacts/preferences.ts (a unit test reads
--   this file). No seed, sample data or test held another value when this was
--   written; the hosted column has never had a writer. Should a row there hold
--   another value, adding the constraint fails and nothing of this migration is
--   applied (one transaction).
-- * contacts.preferred_channel (new, nullable): phone | whatsapp | email | sms.
--   Mirrored by CONTACT_CHANNELS in the same file. Display only: nothing sends by
--   it yet.
-- * Both are granted to clients for insert and update like the other contact
--   columns (RVW-12, migration 0073; preferred_locale was already granted there,
--   granting it again is harmless).
-- * Both are nullable, so app.sample_row() needs nothing (migration 0121).
--   Merge picks (app.merge_columns()) are not changed here: a follow-up.
-- * app.export_choice_values() (migration 0088) gains the values of both lists,
--   so a list export that filtered by them keeps the chosen value in its audit
--   entry instead of `true` (they are fixed codes, not personal data).
-- Every statement is safe to run twice.

alter table public.contacts add column if not exists preferred_channel text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'contacts_preferred_locale_check' and conrelid = 'public.contacts'::regclass) then
    alter table public.contacts add constraint contacts_preferred_locale_check
      check (preferred_locale in ('he', 'ar', 'en', 'ru', 'am', 'fr', 'es'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_preferred_channel_check' and conrelid = 'public.contacts'::regclass) then
    alter table public.contacts add constraint contacts_preferred_channel_check
      check (preferred_channel in ('phone', 'whatsapp', 'email', 'sms'));
  end if;
end;
$$;

comment on column public.contacts.preferred_locale is
  'CON-10: null or he | ar | en | ru | am | fr | es (CONTACT_LOCALES in src/features/contacts/preferences.ts)';
comment on column public.contacts.preferred_channel is
  'CON-10: null or phone | whatsapp | email | sms (CONTACT_CHANNELS in src/features/contacts/preferences.ts); display only';

grant insert (preferred_locale, preferred_channel), update (preferred_locale, preferred_channel)
  on public.contacts to authenticated;

-- the fixed values of the built-in plain choice fields; mirrored from
-- filterFields() (src/features/list-filters/server.ts), checked by
-- tests/unit/export-filter-values.test.ts (which reads the latest definition)
create or replace function app.export_choice_values() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    -- deal status, task status
    'open', 'won', 'lost', 'done', 'cancelled',
    -- task type
    'todo', 'call', 'meeting', 'follow_up',
    -- task priority
    '1', '2', '3',
    -- company industry
    'services', 'real_estate', 'insurance_finance', 'construction', 'retail', 'health',
    'education', 'marketing', 'technology', 'tourism_events', 'nonprofit', 'other',
    -- CON-10: contact preferred language
    'he', 'ar', 'en', 'ru', 'am', 'fr', 'es',
    -- CON-10: contact preferred channel
    'phone', 'whatsapp', 'email', 'sms'
  ];
$$;

revoke all on function app.export_choice_values() from public, anon, authenticated;
