-- =============================================================================
-- 0053 Meetings as their own records (CAL-01)
-- =============================================================================
-- public.meetings: title, type, start and end, place or video link, the
-- customer and the record it is about (any of lead / contact / company / deal,
-- or none for an internal meeting), description, status (planned | held |
-- cancelled | no_show) and outcome. owner_id is the organizer.
-- public.meeting_participants: the team members taking part (one row each).
--
-- Who sees a meeting (additions spec 22.9, "a child record inherits the
-- visibility of its parent"):
--   * whoever may read any record it is linked to (app.can_read_record of that
--     lead / contact / company / deal);
--   * its organizer, its creator and its participants;
--   * whoever may read a record owned by the organizer (owners, admins, and
--     everyone when the organization's visibility is 'org').
-- Organizer: see "The organizer" below; transfer_records moves meetings too.
-- Who edits it: a writer who is its organizer or creator, a participant, an
-- owner/admin, or whoever may edit a record it is linked to. A link is set
-- only to a record the writer can see (trigger meetings_check_links).
-- Deleting: no recycle bin. A meeting that did not happen is "cancelled";
-- delete is for mistakes, by its creator or by those who may delete the
-- organizer's records (admins, a manager for their own). The audit log keeps
-- the deleted row.
-- Purging a linked record clears that link (ON DELETE SET NULL); the meeting
-- stays with its organizer and participants.
-- Read-only / suspended organization: app.can_write is false, so nothing is
-- added, changed or deleted; reading goes on. No plan limit or feature flag.
-- Every statement is safe to run twice.

create table if not exists public.meetings (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  title           text not null check (char_length(btrim(title)) between 1 and 300),
  meeting_type    text not null default 'in_person'
                  check (meeting_type in ('in_person', 'phone', 'video', 'other')),
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  location        text check (char_length(location) <= 500),
  video_url       text check (char_length(video_url) <= 2000 and video_url ~* '^https?://[^\s]+$'),
  description     text check (char_length(description) <= 5000),
  status          text not null default 'planned'
                  check (status in ('planned', 'held', 'cancelled', 'no_show')),
  outcome         text check (char_length(outcome) <= 5000),
  -- the organizer; named owner_id so the usual owner rules and helpers apply
  owner_id        uuid,
  lead_id         uuid,
  contact_id      uuid,
  company_id      uuid,
  deal_id         uuid,
  created_by      uuid references auth.users (id) on delete set null,
  updated_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint meetings_ends_after_start check (ends_at > starts_at and ends_at <= starts_at + interval '14 days'),
  foreign key (organization_id, owner_id) references public.memberships (organization_id, user_id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete set null (lead_id),
  foreign key (organization_id, contact_id) references public.contacts (organization_id, id) on delete set null (contact_id),
  foreign key (organization_id, company_id) references public.companies (organization_id, id) on delete set null (company_id),
  foreign key (organization_id, deal_id) references public.deals (organization_id, id) on delete set null (deal_id)
);

create index if not exists meetings_org_start_idx on public.meetings (organization_id, starts_at);
create index if not exists meetings_owner_start_idx on public.meetings (organization_id, owner_id, starts_at);
create index if not exists meetings_lead_idx on public.meetings (lead_id, starts_at) where lead_id is not null;
create index if not exists meetings_contact_idx on public.meetings (contact_id, starts_at) where contact_id is not null;
create index if not exists meetings_company_idx on public.meetings (company_id, starts_at) where company_id is not null;
create index if not exists meetings_deal_idx on public.meetings (deal_id, starts_at) where deal_id is not null;

create table if not exists public.meeting_participants (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  meeting_id      uuid not null,
  user_id         uuid not null,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (meeting_id, user_id),
  foreign key (organization_id, meeting_id) references public.meetings (organization_id, id) on delete cascade,
  foreign key (organization_id, user_id) references public.memberships (organization_id, user_id) on delete cascade
);

create index if not exists meeting_participants_user_idx on public.meeting_participants (organization_id, user_id);

-- ----------------------------------------------------------------------------
-- Triggers: stamps, default organizer, audit
-- ----------------------------------------------------------------------------
create or replace trigger meetings_touch before insert or update on public.meetings
  for each row execute function app.touch_row();
create or replace trigger meetings_default_owner before insert on public.meetings
  for each row execute function app.default_owner();
create or replace trigger meetings_audit after insert or update or delete on public.meetings
  for each row execute function app.audit_row();

create or replace trigger meeting_participants_touch before insert or update on public.meeting_participants
  for each row execute function app.touch_row();
create or replace trigger meeting_participants_audit after insert or update or delete on public.meeting_participants
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- Row level security on, client grants (policies follow in 0053c): until the
-- policies exist no client can read or write either table.
-- ----------------------------------------------------------------------------
alter table public.meetings enable row level security;
revoke all on public.meetings from anon, authenticated;
grant select, delete on public.meetings to authenticated;
grant insert (organization_id, title, meeting_type, starts_at, ends_at, location, video_url, description,
              status, outcome, owner_id, lead_id, contact_id, company_id, deal_id)
  on public.meetings to authenticated;
grant update (title, meeting_type, starts_at, ends_at, location, video_url, description,
              status, outcome, owner_id, lead_id, contact_id, company_id, deal_id)
  on public.meetings to authenticated;

alter table public.meeting_participants enable row level security;
revoke all on public.meeting_participants from anon, authenticated;
grant select, delete on public.meeting_participants to authenticated;
grant insert (organization_id, meeting_id, user_id) on public.meeting_participants to authenticated;
