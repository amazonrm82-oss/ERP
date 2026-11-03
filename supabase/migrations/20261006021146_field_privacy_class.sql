-- =============================================================================
-- PRK-01: marking a custom field as personal or sensitive information
-- =============================================================================
-- Spec (SPEC-ADDITIONS 18.9, PRK-01, wave 3): the privacy center shows what personal information the business
-- keeps: fields marked as personal or sensitive; the marking itself, in the field settings, is part of the
-- requirement.
-- * field_definitions.privacy_class: null (not marked) | 'personal' | 'sensitive' (check constraint, mirrored by
--   PRIVACY_CLASSES in src/features/privacy-center/classes.ts; a unit test reads this file).
-- * Written like every other field setting: field_definitions has table-level grants and owner/admin write
--   policies of a writable business (0004), so the new column needs no grant of its own; audited by the existing
--   field_definitions_audit trigger.
-- * The mark is information only: no policy, function or export reads it to decide anything.
-- * Privacy, so every plan, no plan key. The built-in personal fields are a fixed list in code
--   (src/features/privacy-center/personal-fields.ts), not stored.
-- Every statement is safe to run twice.

alter table public.field_definitions add column if not exists privacy_class text;

alter table public.field_definitions drop constraint if exists field_definitions_privacy_class_check;
alter table public.field_definitions add constraint field_definitions_privacy_class_check
  check (privacy_class is null or privacy_class in ('personal', 'sensitive'));

comment on column public.field_definitions.privacy_class is
  'PRK-01: null | personal | sensitive; shown in the privacy center, never an access rule';

notify pgrst, 'reload schema';
