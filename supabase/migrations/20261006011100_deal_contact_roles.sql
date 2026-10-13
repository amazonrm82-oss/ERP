-- CON-03: contacts on a deal, each with a role in the purchase.
--
-- public.deal_contacts already exists (0002, policies in 0004) and its rights follow
-- the deal: whoever reads the deal reads its contacts, whoever may edit the deal
-- manages them. This migration only tightens it for the screen:
--
-- 1. role is one of four fixed keys, or empty. The labels live in the app
--    (src/features/deal-contacts/roles.ts); keep the two lists identical.
--    If the hosted table holds other values, this statement fails and changes
--    nothing: check first with a read-only query.
-- 2. A client may change only the role of a link. Moving a link to another deal or
--    contact is "remove and add", so the insert policy below always applies.
-- 3. A new link needs a live contact the caller may read (like task links, 0074),
--    so nobody links a contact they cannot see.

alter table public.deal_contacts drop constraint if exists deal_contacts_role_check;
alter table public.deal_contacts
  add constraint deal_contacts_role_check
  check (role is null or role in ('decision_maker', 'influencer', 'user', 'finance'));

revoke update on public.deal_contacts from authenticated;
grant update (role) on public.deal_contacts to authenticated;

alter policy deal_contacts_insert on public.deal_contacts
  with check (
    exists (
      select 1 from public.deals d
      where d.id = deal_contacts.deal_id
        and app.can_edit_record(d.organization_id, d.owner_id, d.team_id))
    and exists (
      select 1 from public.contacts c
      where c.id = deal_contacts.contact_id
        and c.deleted_at is null));

-- the contact card lists the deals a contact takes part in
create index if not exists deal_contacts_contact_idx on public.deal_contacts (organization_id, contact_id);
