-- =============================================================================
-- SMS-01: the business's SMS sender name
-- =============================================================================
-- SPEC-ADDITIONS SMS-01: a provider connection (InforU or SMS4Free) and a sender name per business. No provider is chosen
-- yet: the adapters live behind the provider layer (src/features/messaging/providers/), only the fake sends, and the InforU
-- and SMS4Free adapters are stubs that are never selected (they refuse to start without their env keys, and are marked
-- not built). Lead's assumption until the owner says otherwise: one PLATFORM account per provider (keys in Vercel env,
-- set by the owner), each business sending under its own sender name; a per-business account would use INT-02's
-- encrypted secrets and is not built.
--
-- * org_message_settings.sms_sender_name (null = the platform account's default sender): what the customer's phone shows
--   as the sender. Israeli sender rules (as the providers apply them): 2..11 Latin letters and digits, not all digits;
--   or a phone number the business answers on (local 0X..., international 972..., or 1700/1800 numbers), digits only
--   with an optional "+". The rule is app.sms_sender_name_ok = smsSenderNameOk() in src/features/messaging/sms-sender.ts
--   (both run tests/unit/fixtures/sms-sender-names.json). Owners and admins of a writable business write it (the
--   table's own policies, column grants); audited by the table's audit trigger. The provider reads it when it sends
--   (through the approved sender path once a real adapter exists; the queue still holds ids and codes only).
-- No row is deleted here. Every statement is safe to run twice.

create or replace function app.sms_sender_name_ok(p_value text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_value is not null and (
    -- a name: 2..11 Latin letters and digits, at least one letter
    (p_value ~ '^[A-Za-z0-9]{2,11}$' and p_value ~ '[A-Za-z]')
    -- a phone number: local (0 + 8..9 digits), international Israeli (972 + 8..9 digits, optional +), or 1700/1800
    or p_value ~ '^0[2-9][0-9]{7,8}$'
    or p_value ~ '^[+]?972[2-9][0-9]{7,8}$'
    or p_value ~ '^1[78]00[0-9]{6}$'
  )
$$;
revoke all on function app.sms_sender_name_ok(text) from public, anon;
grant execute on function app.sms_sender_name_ok(text) to authenticated, service_role;

alter table public.org_message_settings add column if not exists sms_sender_name text;
alter table public.org_message_settings drop constraint if exists org_message_settings_sms_sender_name;
alter table public.org_message_settings add constraint org_message_settings_sms_sender_name
  check (sms_sender_name is null or app.sms_sender_name_ok(sms_sender_name));
grant insert (sms_sender_name) on public.org_message_settings to authenticated;
grant update (sms_sender_name) on public.org_message_settings to authenticated;

comment on column public.org_message_settings.sms_sender_name is
  'SMS-01: the sender the customer''s phone shows (app.sms_sender_name_ok); null = the platform account''s default';
