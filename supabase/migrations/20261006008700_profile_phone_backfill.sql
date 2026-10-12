-- =============================================================================
-- One-time fill of the normalized phone in existing profiles (USR-01)
-- =============================================================================
-- Since 0066 trigger profiles_check sets profiles.phone_e164 from phone on every
-- write, but rows written before it still have phone_e164 null until the user
-- saves the profile again. The owner approved on 12 October 2026 a one-time
-- fill under these rules:
--
-- * Only rows whose phone_e164 is null and whose phone is not empty. A value
--   already there is never touched, so the second run finds nothing to do.
-- * The value is app.normalize_phone(phone), the same normalizer leads,
--   contacts, companies and profiles_check use (it is also what profiles_check
--   recomputes during this very update, so the two cannot differ).
-- * Only numbers that normalize without doubt are filled:
--   - the phone holds only phone characters: digits, spaces, '-', '.', '(', ')'
--     and one leading '+' (no letters, no '/', no second number), and
--   - no "(0)" in it (an optional trunk 0 that the normalizer would keep), and
--   - the result is an Israeli number with the right length for its prefix
--     (from 0XX..., 972... or +972...): mobile 5X and 7X with 9 digits after
--     972, landlines 2, 3, 4, 8, 9 with 8 digits, or
--   - the phone was written as international (starts with '+' or '00') for
--     another country and the result is + and 8 to 15 digits (E.164) not
--     starting with 0.
--   Anything else (too short, too long, local without a leading 0, a trunk 0
--   after +972, text mixed in, garbage) stays null and is counted.
-- * The phone as typed is never changed (phone is not in the SET list, and
--   profiles_check does not write it).
-- * Not an edit by the user: updated_at stays as it was. profiles has no
--   updated_by; its touch trigger (profiles_touch, app.touch_row) would set
--   updated_at = now(), so it is disabled for the duration of this one block
--   and enabled again at its end (lock_timeout 5s for the block, so it never
--   waits long behind another transaction). The block is one statement, so the trigger is
--   off only inside this transaction: other sessions wait on the table lock and
--   never write a profile while it is off; a failure rolls the whole block back
--   with the trigger enabled. profiles has no audit or event trigger, and no
--   column of it starts an automation or a notification.
-- * Only an update of the new column; the counts are reported with RAISE NOTICE:
--   filled now, still without a normalized phone (phone set, phone_e164 null),
--   and all profiles with a phone.
-- Safe to run twice.

do $$
declare
  v_filled integer;
begin
  -- do not queue behind a long transaction while holding up profile writes
  perform set_config('lock_timeout', '5s', true);
  alter table public.profiles disable trigger profiles_touch;

  update public.profiles p
     set phone_e164 = app.normalize_phone(p.phone)
   where p.phone_e164 is null
     and p.phone is not null
     and btrim(p.phone) <> ''
     and btrim(p.phone) ~ '^\+?[0-9 ().-]+$'
     and p.phone !~ '\(\s*0\s*\)'
     and (
       app.normalize_phone(p.phone) ~ '^\+972(5[0-9]{8}|7[0-9]{8}|[2-489][0-9]{7})$'
       or (
         (btrim(p.phone) like '+%' or btrim(p.phone) like '00%')
         and app.normalize_phone(p.phone) not like '+972%'
         and app.normalize_phone(p.phone) ~ '^\+[1-9][0-9]{7,14}$'
       )
     );
  get diagnostics v_filled = row_count;

  alter table public.profiles enable trigger profiles_touch;

  raise notice 'profile phone backfill: filled %, still without a normalized phone %, profiles with a phone %',
    v_filled,
    (select count(*) from public.profiles where phone is not null and btrim(phone) <> '' and phone_e164 is null),
    (select count(*) from public.profiles where phone is not null and btrim(phone) <> '');
end;
$$;
