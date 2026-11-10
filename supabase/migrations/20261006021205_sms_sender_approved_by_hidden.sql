-- =============================================================================
-- SMS-01b final review (8): clients no longer read who on the platform approved a business's SMS sender name
-- =============================================================================
-- org_message_settings.sms_sender_approved_by is a platform staff user id. Clients select every other column through
-- column grants from now on, so a NEW column of this table needs its own select grant (and its place in EXPORT_COLUMNS in
-- src/features/imports/export-build.ts, which names the readable columns).
-- Split out of 021204 so it is applied only AFTER the code that names the readable columns is live: until then the running
-- full export reads this table with select * (CLAUDE.md, Migrations: a migration stays backward compatible).
-- Every statement is safe to run twice. No drops, no deletes.

revoke select on public.org_message_settings from authenticated;
grant select (id, organization_id, window_from, window_until, skip_rest_days, updated_by, created_at, updated_at, monthly_cap_email, monthly_cap_sms, monthly_cap_whatsapp, meeting_confirm, meeting_remind_day, meeting_remind_hour, sms_sender_name, sms_sender_verified_phone, sms_sender_verified_at, sms_sender_approved_at, sms_sender_rejected_at) on public.org_message_settings to authenticated;
