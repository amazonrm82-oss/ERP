// Hand-written types for the part of the schema this app uses.
// Source of truth: supabase/migrations/*.sql. Keep the two in sync; replace
// this file with `supabase gen types typescript` once a project is linked.
//
// Notes that are easy to get wrong:
//   * bigint columns (amount_agorot, budget_agorot) arrive as JS numbers. Values
//     above Number.MAX_SAFE_INTEGER agorot are far outside this product's range.
//   * `Insert` lists only columns a signed-in client may write (column grants
//     and triggers reject or overwrite the rest).
//   * Relationships are left empty on purpose: queries here never use
//     PostgREST embedding, they fetch lookups separately and join in code.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type MembershipRole = "owner" | "admin" | "manager" | "member" | "viewer";
export type MembershipStatus = "active" | "suspended";
export type SeatType = "full" | "view";
export type OrgStatus = "trial" | "active" | "past_due" | "read_only" | "suspended" | "cancelled";
export type RecordVisibility = "org" | "team" | "own";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled";
export type BillingCycle = "monthly" | "annual";
export type StageKind = "open" | "won" | "lost";
export type LeadStatusKind = "open" | "converted" | "disqualified";
export type TaskStatus = "open" | "done" | "cancelled";
export type ViewScope = "private" | "team" | "org";

type Table<Row, Insert, Update = Partial<Insert>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

// A table the client can only read.
type ReadOnlyTable<Row> = Table<Row, Record<string, never>, Record<string, never>>;

export type ListPreferencesRow = {
  id: string;
  organization_id: string;
  user_id: string;
  object_type: string;
  columns: Json;
  updated_at: string;
};

// CAL-03 (calendar settings migration): the organization's rest days; 0 = Sunday … 6 = Saturday
export type OrgCalendarSettingsRow = {
  id: string;
  organization_id: string;
  rest_weekdays: number[];
  holidays_rest: boolean;
  holiday_eves_rest: boolean;
  // CAL-03 (migration 0094): occasions chosen as rest days one by one (keys of OCCASIONS)
  rest_occasions: string[];
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};
type OrgCalendarSettingsWrite = { rest_weekdays?: number[]; holidays_rest?: boolean; holiday_eves_rest?: boolean; rest_occasions?: string[] };

// CAL-01 (meetings migration): a meeting and its team participants
export type MeetingType = "in_person" | "phone" | "video" | "other";
export type MeetingStatus = "planned" | "held" | "cancelled" | "no_show";

export type MeetingRow = {
  id: string;
  organization_id: string;
  title: string;
  meeting_type: string;
  starts_at: string;
  ends_at: string;
  location: string | null;
  video_url: string | null;
  description: string | null;
  status: string;
  outcome: string | null;
  owner_id: string | null;
  lead_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  // CAL-06: minutes before the start that the team is reminded (5, 15, 30, 60, 1440); null = no reminder
  reminder_minutes: number | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type MeetingInsert = {
  organization_id: string;
  title: string;
  meeting_type?: MeetingType;
  starts_at: string;
  ends_at: string;
  location?: string | null;
  video_url?: string | null;
  description?: string | null;
  status?: MeetingStatus;
  outcome?: string | null;
  owner_id?: string | null;
  lead_id?: string | null;
  contact_id?: string | null;
  company_id?: string | null;
  deal_id?: string | null;
  reminder_minutes?: number | null;
};

export type MeetingUpdate = Partial<Omit<MeetingInsert, "organization_id">>;

export type MeetingParticipantRow = {
  id: string;
  organization_id: string;
  meeting_id: string;
  user_id: string;
  created_by: string | null;
  created_at: string;
};

export type NotificationSettingsRow = {
  user_id: string;
  muted: string[];
  no_push: string[];
  updated_at: string;
};

export type PlanRow = {
  key: string;
  name_he: string;
  name_en: string;
  price_monthly_agorot: number;
  price_annual_agorot: number;
  limits: Json;
  features: Json;
  is_public: boolean;
  position: number;
};

export type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  industry: string | null;
  team_size: string | null;
  phone: string | null;
  locale: string;
  timezone: string;
  currency: string;
  record_visibility: RecordVisibility;
  status: OrgStatus;
  // members must pass two-step verification (enforced in app.membership_role)
  require_mfa: boolean;
  // USR-03: next step of the setup wizard (1..4); null = finished, skipped, or an older organization
  setup_step: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  locale: string;
  phone_e164: string | null;
  timezone: string | null;
  // USR-01: {"sun": [{"start": "08:00", "end": "12:00"}, ...], ...} (or one object per day, first version); see src/features/profile/working-hours.ts
  working_hours: Json | null;
  signature: string | null;
  created_at: string;
  updated_at: string;
};

export type MembershipRow = {
  id: string;
  organization_id: string;
  user_id: string;
  role: MembershipRole;
  seat_type: SeatType;
  status: MembershipStatus;
  is_available: boolean;
  // round-robin memory, written only by the database
  last_lead_assigned_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TeamRow = {
  id: string;
  organization_id: string;
  name: string;
  parent_team_id: string | null;
  created_at: string;
  updated_at: string;
};

export type TeamMemberRow = {
  organization_id: string;
  team_id: string;
  user_id: string;
  is_manager: boolean;
  // CAP-06: the team the user's records join when they sit in several teams
  is_primary: boolean;
  created_at: string;
};

export type InvitationRow = {
  id: string;
  organization_id: string;
  email: string;
  role: MembershipRole;
  token_hash: string;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type SubscriptionRow = {
  organization_id: string;
  plan_key: string;
  status: SubscriptionStatus;
  billing_cycle: BillingCycle;
  seats: number | null;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  limit_overrides: Json;
  feature_overrides: Json;
  provider: string | null;
  provider_customer_ref: string | null;
  provider_subscription_ref: string | null;
  created_at: string;
  updated_at: string;
};

export type PipelineRow = {
  id: string;
  organization_id: string;
  name: string;
  position: number;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type StageRow = {
  id: string;
  organization_id: string;
  pipeline_id: string;
  name: string;
  position: number;
  kind: StageKind;
  probability: number;
  color: string | null;
  rot_days: number | null;
  created_at: string;
  updated_at: string;
};

export type LeadStatusRow = {
  id: string;
  organization_id: string;
  name: string;
  kind: LeadStatusKind;
  position: number;
  color: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export type LeadSourceRow = {
  id: string;
  organization_id: string;
  name: string;
  kind: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

// LEAD-03: the reasons an organization offers for "not relevant" (migration disqualify_reasons)
export type DisqualifyReasonRow = {
  id: string;
  organization_id: string;
  name: string;
  position: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

// CON-02: the contact and company types an organization offers (migration record_types)
export type RecordTypeObject = "contact" | "company";
export type RecordTypeOptionRow = {
  id: string;
  organization_id: string;
  // text with a check constraint: 'contact' | 'company' (RecordTypeObject)
  object_type: string;
  name: string;
  position: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type TagRow = {
  id: string;
  organization_id: string;
  name: string;
  color: string | null;
  created_by: string | null;
  created_at: string;
};

export type FieldDefinitionRow = {
  id: string;
  organization_id: string;
  object_type: string;
  key: string;
  label: string;
  field_type: string;
  options: Json;
  is_required: boolean;
  is_active: boolean;
  help_text: string | null;
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type SavedViewRow = {
  id: string;
  organization_id: string;
  object_type: string;
  name: string;
  config: Json;
  scope: ViewScope;
  owner_id: string;
  team_id: string | null;
  created_at: string;
  updated_at: string;
};

export type FormKind = "form" | "webhook";
export type AssignMode = "owner" | "round_robin";

export type FormRow = {
  id: string;
  organization_id: string;
  kind: string;
  name: string;
  // forms: public id in the embed code; webhooks: the secret in the URL
  token: string;
  title: string | null;
  intro: string | null;
  submit_label: string | null;
  success_message: string | null;
  redirect_url: string | null;
  fields: Json;
  source_id: string | null;
  owner_id: string | null;
  team_id: string | null;
  assign_mode: string;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type FormSubmissionRow = {
  id: string;
  organization_id: string;
  form_id: string | null;
  form_name: string | null;
  form_deleted_at: string | null;
  status: string;
  lead_id: string | null;
  payload: Json;
  ip_hash: string | null;
  user_agent: string | null;
  created_at: string;
};

export type AutomationRow = {
  id: string;
  organization_id: string;
  name: string;
  template_key: string | null;
  is_active: boolean;
  entity_type: string;
  trigger_type: string;
  trigger_config: Json;
  conditions: Json;
  actions: Json;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AutomationRunRow = {
  id: string;
  organization_id: string;
  automation_id: string;
  entity_type: string;
  entity_id: string;
  run_key: string;
  status: string;
  steps: Json;
  created_at: string;
};

export type NotificationRow = {
  id: string;
  organization_id: string;
  user_id: string;
  // one of NOTIFICATION_KINDS (src/features/notifications/settings.ts) or system; checked by notifications_kinds
  type: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  read_at: string | null;
  // set by the push dispatcher
  pushed_at: string | null;
  created_at: string;
};

export type ImportEntity = "lead" | "contact" | "company";
export type DuplicateMode = "skip" | "update" | "create";
export type ImportStatus = "running" | "done" | "failed" | "undone";

export type ImportJobRow = {
  id: string;
  organization_id: string;
  // ImportEntity (text + check constraint)
  entity_type: string;
  file_name: string;
  // DuplicateMode
  duplicate_mode: string;
  // ImportStatus
  status: string;
  total_rows: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  failed_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  undone_at: string | null;
};

export type SupportAccessGrantRow = {
  id: string;
  organization_id: string;
  granted_by: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type FileRow = {
  id: string;
  organization_id: string;
  lead_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  name: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  uploaded_by: string | null;
  created_at: string;
};

export type PlatformRole = "owner" | "support" | "finance" | "readonly";

export type AuditLogRow = {
  id: number;
  organization_id: string;
  actor_id: string | null;
  // insert | update | delete | trash | restore | support_open
  action: string;
  entity_type: string;
  entity_id: string | null;
  // update: { field: { old, new } }   delete: the full old row
  changes: Json;
  created_at: string;
};

export type PushSubscriptionRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
};

export type CompanyRow = {
  id: string;
  organization_id: string;
  name: string;
  tax_id: string | null;
  company_type: string | null;
  // CON-02: from record_type_options; company_type is the older free text
  type_id: string | null;
  industry: string | null;
  size: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  phone_e164: string | null;
  address_line: string | null;
  city: string | null;
  postal_code: string | null;
  country: string;
  parent_company_id: string | null;
  owner_id: string | null;
  team_id: string | null;
  tag_ids: string[];
  custom_fields: Json;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // set when the record was created by an import (undo moves these to the recycle bin)
  import_job_id: string | null;
};

export type CompanyInsert = {
  organization_id: string;
  import_job_id?: string | null;
  name: string;
  tax_id?: string | null;
  company_type?: string | null;
  type_id?: string | null;
  industry?: string | null;
  size?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  address_line?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country?: string;
  parent_company_id?: string | null;
  owner_id?: string | null;
  team_id?: string | null;
  tag_ids?: string[];
  custom_fields?: Json;
  deleted_at?: string | null;
};

export type ContactRow = {
  id: string;
  organization_id: string;
  first_name: string | null;
  last_name: string | null;
  // generated column: first_name + ' ' + last_name, null when both are empty
  full_name: string | null;
  email: string | null;
  phone: string | null;
  phone_e164: string | null;
  job_title: string | null;
  contact_type: string | null;
  // CON-02: from record_type_options; contact_type is the older free text
  type_id: string | null;
  company_id: string | null;
  source_id: string | null;
  address_line: string | null;
  city: string | null;
  birth_date: string | null;
  preferred_locale: string | null;
  owner_id: string | null;
  team_id: string | null;
  tag_ids: string[];
  custom_fields: Json;
  last_contacted_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // set when the record was created by an import (undo moves these to the recycle bin)
  import_job_id: string | null;
};

export type ContactInsert = {
  organization_id: string;
  import_job_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  job_title?: string | null;
  contact_type?: string | null;
  type_id?: string | null;
  company_id?: string | null;
  source_id?: string | null;
  address_line?: string | null;
  city?: string | null;
  birth_date?: string | null;
  preferred_locale?: string | null;
  owner_id?: string | null;
  team_id?: string | null;
  tag_ids?: string[];
  custom_fields?: Json;
  last_contacted_at?: string | null;
  deleted_at?: string | null;
};

export type LeadRow = {
  id: string;
  organization_id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  phone_e164: string | null;
  company_name: string | null;
  job_title: string | null;
  status_id: string;
  source_id: string | null;
  campaign: string | null;
  utm: Json;
  score: number;
  budget_agorot: number | null;
  message: string | null;
  disqualify_reason: string | null;
  owner_id: string | null;
  team_id: string | null;
  tag_ids: string[];
  custom_fields: Json;
  first_contacted_at: string | null;
  last_contacted_at: string | null;
  converted_at: string | null;
  converted_contact_id: string | null;
  converted_company_id: string | null;
  converted_deal_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // set when the record was created by an import (undo moves these to the recycle bin)
  import_job_id: string | null;
  // CAP-02 / ADS-01: set by the lead intake only (no client grant); first touch, never overwritten
  referrer_url: string | null;
  landing_url: string | null;
  gclid: string | null;
  fbclid: string | null;
  ctwa_clid: string | null;
  meta_lead_id: string | null;
};

export type LeadInsert = {
  organization_id: string;
  import_job_id?: string | null;
  status_id: string;
  full_name?: string | null;
  email?: string | null;
  phone?: string | null;
  company_name?: string | null;
  job_title?: string | null;
  source_id?: string | null;
  campaign?: string | null;
  utm?: Json;
  score?: number;
  budget_agorot?: number | null;
  message?: string | null;
  disqualify_reason?: string | null;
  owner_id?: string | null;
  team_id?: string | null;
  tag_ids?: string[];
  custom_fields?: Json;
  first_contacted_at?: string | null;
  last_contacted_at?: string | null;
  deleted_at?: string | null;
};

export type DealRow = {
  id: string;
  organization_id: string;
  name: string;
  amount_agorot: number;
  currency: string;
  pipeline_id: string;
  stage_id: string;
  // maintained by the sync_deal_stage trigger
  status: StageKind;
  probability: number;
  expected_close_date: string | null;
  stage_entered_at: string;
  closed_at: string | null;
  lost_reason: string | null;
  contact_id: string | null;
  company_id: string | null;
  source_id: string | null;
  owner_id: string | null;
  team_id: string | null;
  tag_ids: string[];
  custom_fields: Json;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type DealInsert = {
  organization_id: string;
  name: string;
  pipeline_id: string;
  stage_id: string;
  amount_agorot?: number;
  currency?: string;
  expected_close_date?: string | null;
  lost_reason?: string | null;
  contact_id?: string | null;
  company_id?: string | null;
  source_id?: string | null;
  owner_id?: string | null;
  team_id?: string | null;
  tag_ids?: string[];
  custom_fields?: Json;
  deleted_at?: string | null;
};

export type ActivityRow = {
  id: string;
  organization_id: string;
  // note | call | meeting | email | whatsapp | sms | stage_change | status_change
  // | conversion | assignment | system
  type: string;
  body: string | null;
  metadata: Json;
  occurred_at: string;
  is_pinned: boolean;
  // GAP-05: a private note, seen only by its author and the organization's owners/admins
  is_private: boolean;
  lead_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ActivityInsert = {
  organization_id: string;
  type: string;
  body?: string | null;
  metadata?: Json;
  occurred_at?: string;
  is_pinned?: boolean;
  // only on a note (check activities_private_note)
  is_private?: boolean;
  lead_id?: string | null;
  contact_id?: string | null;
  company_id?: string | null;
  deal_id?: string | null;
};

// Column grant: only these columns may be updated by a client.
export type ActivityUpdate = {
  body?: string | null;
  metadata?: Json;
  occurred_at?: string;
  is_pinned?: boolean;
  is_private?: boolean;
};

export type TaskRow = {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  task_type: string;
  due_at: string | null;
  remind_at: string | null;
  // set when the reminder was sent; cleared when remind_at changes
  reminded_at: string | null;
  priority: number;
  status: TaskStatus;
  completed_at: string | null;
  outcome: string | null;
  owner_id: string | null;
  team_id: string | null;
  lead_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  // TASK-04: how the task repeats (shape in src/features/tasks/recurrence.ts); null = once
  recurrence: Json | null;
  // the completed task this one was created from; written by the database only
  recurrence_source_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type TaskInsert = {
  organization_id: string;
  title: string;
  description?: string | null;
  task_type?: string;
  due_at?: string | null;
  remind_at?: string | null;
  priority?: number;
  status?: TaskStatus;
  outcome?: string | null;
  owner_id?: string | null;
  team_id?: string | null;
  lead_id?: string | null;
  contact_id?: string | null;
  company_id?: string | null;
  deal_id?: string | null;
  recurrence?: Json | null;
  deleted_at?: string | null;
};

// convert_lead() returns this object as jsonb.
export type ConvertLeadResult = {
  contact_id: string;
  company_id: string | null;
  deal_id: string | null;
};

export type Database = {
  public: {
    Tables: {
      plans: ReadOnlyTable<PlanRow>;
      organizations: Table<
        OrganizationRow,
        // created only through create_organization()
        Record<string, never>,
        {
          name?: string;
          industry?: string | null;
          team_size?: string | null;
          phone?: string | null;
          locale?: string;
          timezone?: string;
          currency?: string;
          record_visibility?: RecordVisibility;
          require_mfa?: boolean;
          setup_step?: number | null;
        }
      >;
      profiles: Table<
        ProfileRow,
        Record<string, never>,
        {
          full_name?: string | null;
          phone?: string | null;
          avatar_url?: string | null;
          locale?: string;
          timezone?: string | null;
          working_hours?: Json | null;
          signature?: string | null;
        }
      >;
      memberships: Table<
        MembershipRow,
        // created only through create_organization() / accept_invitation()
        Record<string, never>,
        { role?: MembershipRole; seat_type?: SeatType; status?: MembershipStatus; is_available?: boolean }
      >;
      subscriptions: ReadOnlyTable<SubscriptionRow>;
      teams: Table<TeamRow, { organization_id: string; name: string; parent_team_id?: string | null }>;
      team_members: Table<
        TeamMemberRow,
        { organization_id: string; team_id: string; user_id: string; is_manager?: boolean; is_primary?: boolean },
        { is_manager?: boolean; is_primary?: boolean }
      >;
      invitations: Table<
        InvitationRow,
        // created only through create_invitation()
        Record<string, never>,
        { revoked_at?: string | null }
      >;
      pipelines: Table<
        PipelineRow,
        { organization_id: string; name: string; position?: number; is_default?: boolean; deleted_at?: string | null }
      >;
      stages: Table<
        StageRow,
        {
          organization_id: string;
          pipeline_id: string;
          name: string;
          position?: number;
          kind?: StageKind;
          probability?: number;
          color?: string | null;
          rot_days?: number | null;
        }
      >;
      lead_statuses: Table<
        LeadStatusRow,
        {
          organization_id: string;
          name: string;
          kind?: LeadStatusKind;
          position?: number;
          color?: string | null;
          is_default?: boolean;
        }
      >;
      lead_sources: Table<
        LeadSourceRow,
        { organization_id: string; name: string; kind?: string; is_active?: boolean }
      >;
      disqualify_reasons: Table<DisqualifyReasonRow, { organization_id: string; name: string; position?: number; is_active?: boolean }>;
      // organization and object type are fixed (column-level update grant)
      record_type_options: Table<
        RecordTypeOptionRow,
        { organization_id: string; object_type: RecordTypeObject; name: string; position?: number; is_active?: boolean },
        { name?: string; position?: number; is_active?: boolean }
      >;
      tags: Table<TagRow, { organization_id: string; name: string; color?: string | null }>;
      field_definitions: Table<
        FieldDefinitionRow,
        {
          organization_id: string;
          object_type: string;
          key: string;
          label: string;
          field_type: string;
          options?: Json;
          is_required?: boolean;
          is_active?: boolean;
          help_text?: string | null;
          position?: number;
        }
      >;
      saved_views: Table<
        SavedViewRow,
        {
          organization_id: string;
          object_type: string;
          name: string;
          config?: Json;
          scope?: ViewScope;
          owner_id: string;
          team_id?: string | null;
        }
      >;
      forms: Table<
        FormRow,
        {
          organization_id: string;
          kind?: FormKind;
          name: string;
          title?: string | null;
          intro?: string | null;
          submit_label?: string | null;
          success_message?: string | null;
          redirect_url?: string | null;
          fields?: Json;
          source_id?: string | null;
          owner_id?: string | null;
          team_id?: string | null;
          assign_mode?: AssignMode;
          is_active?: boolean;
        },
        {
          name?: string;
          title?: string | null;
          intro?: string | null;
          submit_label?: string | null;
          success_message?: string | null;
          redirect_url?: string | null;
          fields?: Json;
          source_id?: string | null;
          owner_id?: string | null;
          team_id?: string | null;
          assign_mode?: AssignMode;
          is_active?: boolean;
        }
      >;
      // written only by intake_submit()
      form_submissions: ReadOnlyTable<FormSubmissionRow>;
      automations: Table<
        AutomationRow,
        {
          organization_id: string;
          name: string;
          template_key?: string | null;
          is_active?: boolean;
          entity_type: string;
          trigger_type: string;
          trigger_config?: Json;
          conditions?: Json;
          actions: Json;
        },
        {
          name?: string;
          is_active?: boolean;
          trigger_type?: string;
          trigger_config?: Json;
          conditions?: Json;
          actions?: Json;
        }
      >;
      // written only by the automation engine
      automation_runs: ReadOnlyTable<AutomationRunRow>;
      // written only by triggers and platform functions; readable by the organization's admins
      audit_log: ReadOnlyTable<AuditLogRow>;
      notifications: Table<NotificationRow, Record<string, never>, { read_at?: string | null }>;
      support_access_grants: Table<SupportAccessGrantRow, { organization_id: string; expires_at: string }, { revoked_at?: string | null }>;
      // files on records (migration 0019): the path and the uploader are set by trigger; no updates
      files: Table<
        FileRow,
        {
          organization_id: string;
          lead_id?: string | null;
          contact_id?: string | null;
          company_id?: string | null;
          deal_id?: string | null;
          name: string;
          mime_type: string;
          size_bytes: number;
        },
        Record<string, never>
      >;
      import_jobs: Table<
        ImportJobRow,
        { organization_id: string; entity_type: ImportEntity; file_name: string; duplicate_mode: DuplicateMode; total_rows?: number },
        {
          status?: ImportStatus;
          created_count?: number;
          updated_count?: number;
          skipped_count?: number;
          failed_count?: number;
          finished_at?: string | null;
          undone_at?: string | null;
        }
      >;
      push_subscriptions: Table<
        PushSubscriptionRow,
        // user_id is set by the database from the session
        { endpoint: string; p256dh: string; auth: string; user_agent?: string | null },
        Record<string, never>
      >;
      // read your own row; written through set_notification_settings() (migration 0031)
      notification_settings: ReadOnlyTable<NotificationSettingsRow>;
      // each user's columns per list (migration 0033); user_id comes from the session
      list_preferences: Table<ListPreferencesRow, { organization_id: string; object_type: string; columns?: Json }, { columns?: Json }>;
      companies: Table<CompanyRow, CompanyInsert>;
      contacts: Table<ContactRow, ContactInsert>;
      leads: Table<LeadRow, LeadInsert>;
      deals: Table<DealRow, DealInsert>;
      activities: Table<ActivityRow, ActivityInsert, ActivityUpdate>;
      tasks: Table<TaskRow, TaskInsert>;
      meetings: Table<MeetingRow, MeetingInsert, MeetingUpdate>;
      meeting_participants: Table<MeetingParticipantRow, { organization_id: string; meeting_id: string; user_id: string }, Record<string, never>>;
      org_calendar_settings: Table<OrgCalendarSettingsRow, OrgCalendarSettingsWrite & { organization_id: string }, OrgCalendarSettingsWrite>;
    };
    Views: { [_ in never]: never };
    Functions: {
      create_organization: {
        Args: { p_name: string; p_industry?: string | null; p_team_size?: string | null; p_phone?: string | null };
        Returns: string;
      };
      create_invitation: {
        Args: { p_organization_id: string; p_email: string; p_role?: MembershipRole };
        // the raw token, shown once
        Returns: string;
      };
      accept_invitation: {
        Args: { p_token: string };
        Returns: string;
      };
      transfer_ownership: {
        Args: { p_organization_id: string; p_new_owner: string };
        Returns: undefined;
      };
      // service-role only (the app's intake routes)
      // CAP-01 (migration 0054): what the hosted form shows; service_role only
      intake_form: { Args: { p_token: string }; Returns: Json };
      intake_submit: {
        Args: {
          p_token: string;
          p_kind: FormKind;
          p_payload: Json;
          p_ip_hash?: string | null;
          p_user_agent?: string | null;
          p_is_spam?: boolean;
        };
        Returns: Json;
      };
      // reports (migration 0011): security invoker, RLS decides what is counted; all return jsonb
      report_leads_by_source: { Args: { p_org: string; p_from: string; p_to: string; p_owner?: string | null }; Returns: Json };
      report_funnel: { Args: { p_org: string; p_from: string; p_to: string; p_owner?: string | null; p_pipeline?: string | null }; Returns: Json };
      report_response_time: { Args: { p_org: string; p_from: string; p_to: string; p_owner?: string | null }; Returns: Json };
      report_rep_performance: { Args: { p_org: string; p_from: string; p_to: string; p_pipeline?: string | null }; Returns: Json };
      report_activity: { Args: { p_org: string; p_from: string; p_to: string; p_owner?: string | null }; Returns: Json };
      report_forecast: { Args: { p_org: string; p_pipeline?: string | null; p_owner?: string | null }; Returns: Json };
      report_lost_reasons: { Args: { p_org: string; p_from: string; p_to: string; p_pipeline?: string | null; p_owner?: string | null }; Returns: Json };
      report_cycle_length: { Args: { p_org: string; p_from: string; p_to: string; p_pipeline?: string | null; p_owner?: string | null }; Returns: Json };
      report_stuck_deals: { Args: { p_org: string; p_pipeline?: string | null; p_owner?: string | null; p_days?: number }; Returns: Json };
      report_revenue: { Args: { p_org: string; p_from: string; p_to: string; p_pipeline?: string | null; p_owner?: string | null }; Returns: Json };
      report_summary: {
        Args: { p_org: string; p_from: string; p_to: string; p_prev_from: string; p_prev_to: string; p_owner?: string | null };
        Returns: Json;
      };
      // account security (migration 0014)
      mfa_required_orgs: { Args: Record<string, never>; Returns: Json };
      // { enrolled: boolean, aal: string }
      mfa_status: { Args: Record<string, never>; Returns: Json };
      // backup codes (migration 0015): create needs aal2 and returns string[] once;
      // recover returns { ok, reason?: "wrong" | "too_many" | "no_factor" }
      mfa_recovery_codes_create: { Args: Record<string, never>; Returns: Json };
      mfa_recovery_codes_status: { Args: Record<string, never>; Returns: Json };
      mfa_recovery_codes_clear: { Args: Record<string, never>; Returns: undefined };
      mfa_recover: { Args: { p_code: string }; Returns: Json };
      // reset of two-step verification (migration 0016)
      org_members_mfa: { Args: { p_org: string }; Returns: Json };
      org_reset_member_mfa: { Args: { p_org: string; p_user: string }; Returns: undefined };
      platform_find_user: { Args: { p_email: string }; Returns: Json };
      platform_reset_mfa: { Args: { p_user: string; p_reason: string; p_check: string }; Returns: undefined };
      // signed agreement (migration 0016)
      sign_agreement: { Args: { p_version: string; p_documents: Json; p_full_name: string; p_method: string; p_signature: string | null }; Returns: string };
      agreement_status: { Args: Record<string, never>; Returns: string | null };
      set_notification_settings: { Args: { p_muted: string[]; p_no_push: string[] }; Returns: undefined };
      // computed fields for sorting lists (migration 0032): used as `order=sort_owner`, not called as RPCs
      sort_status: { Args: Record<string, never>; Returns: number | null };
      sort_source: { Args: Record<string, never>; Returns: string | null };
      sort_owner: { Args: Record<string, never>; Returns: string | null };
      sort_company: { Args: Record<string, never>; Returns: string | null };
      // deals and tasks lists (migration 0035)
      sort_stage: { Args: Record<string, never>; Returns: number | null };
      sort_contact: { Args: Record<string, never>; Returns: string | null };
      // contacts and companies by type (CON-02)
      sort_type: { Args: Record<string, never>; Returns: number | null };
      // a page's organization context in one call (migration 0028)
      org_context: { Args: { p_org: string }; Returns: Json };
      // plan, limits and usage of a business, members only (migration 0046, FXU-04)
      org_plan_usage: { Args: { p_org: string }; Returns: Json };
      my_agreement: { Args: Record<string, never>; Returns: Json };
      // global search (migration 0017), security invoker: { leads, contacts, companies, deals, notes }
      search_records: { Args: { p_org: string; p_query: string; p_limit?: number }; Returns: Json };
      // deals board (migration 0022), security invoker: [{ stage_id, count, amount_agorot }]
      deal_stage_totals: { Args: { p_org: string; p_pipeline: string }; Returns: Json };
      // contact / company card summary (REC-10), security invoker:
      // { deals: [{ status, currency, count, sum }], last_touch, next_task, open_tasks }
      record_summary: { Args: { p_org: string; p_type: string; p_id: string }; Returns: Json };
      // invitation page (migration 0023): null when the token matches nothing
      invitation_preview: { Args: { p_token: string }; Returns: Json };
      // handover (migration 0024): { leads, contacts, companies, deals, tasks } moved
      set_primary_team: { Args: { p_org: string; p_team: string; p_user: string; p_primary: boolean }; Returns: undefined };
      transfer_records: { Args: { p_org: string; p_from: string; p_to: string }; Returns: Json };
      // busy times of people in a meeting (CAL-05): id and title only of meetings the caller may read
      meeting_busy: {
        Args: { p_org: string; p_users: string[]; p_from: string; p_to: string; p_exclude?: string | null };
        Returns: Array<{ user_id: string; meeting_id: string | null; title: string | null; starts_at: string; ends_at: string }>;
      };
      // CAL-07: the personal calendar link (migration 0102); calendar_feed_events is service_role only
      calendar_feed_status: { Args: { p_org: string }; Returns: Json };
      calendar_feed_create: { Args: { p_org: string }; Returns: string };
      calendar_feed_revoke: { Args: { p_org: string }; Returns: undefined };
      calendar_feed_events: { Args: { p_token: string }; Returns: Json };
      // REC-02: who a note on this record may mention (active members who may see it, not the caller)
      mention_candidates: { Args: { p_org: string; p_kind: string; p_id: string }; Returns: Array<{ user_id: string; name: string }> };
      // merging duplicates (migration 0020): picks = { column: "merge" }
      merge_records: { Args: { p_org: string; p_type: string; p_keep: string; p_merge: string; p_picks?: Json }; Returns: undefined };
      my_sessions: { Args: Record<string, never>; Returns: Json };
      org_login_events: { Args: { p_org: string; p_limit?: number }; Returns: Json };
      // privacy erasure (migration 0027)
      audit_erase_candidates: { Args: { p_org: string; p_query: string }; Returns: Json };
      audit_erase_record: { Args: { p_org: string; p_type: string; p_id: string }; Returns: number };
      // adds and removes tags on one record (migration 0042)
      change_record_tags: { Args: { p_table: string; p_org: string; p_id: string; p_add: string[]; p_remove: string[] }; Returns: boolean };
      // import duplicates of a chunk, with the caller's rights (migration 0044)
      import_find_duplicates: {
        Args: { p_org: string; p_entity: string; p_phones: string[]; p_emails: string[]; p_tax_ids: string[]; p_names: string[] };
        Returns: Array<{ id: string; phone_e164: string | null; email: string | null; tax_id: string | null; name: string | null }>;
      };
      // an exported list goes to the audit log (migration 0034)
      log_export: { Args: { p_org: string; p_kind: string; p_report: string | null; p_rows: number }; Returns: undefined };
      log_list_export: { Args: { p_org: string; p_object: string; p_format: string; p_rows: number; p_scope: string; p_filters: Json }; Returns: undefined };
      // platform admin (migration 0013): each checks the platform role and aal2 itself
      support_session_info: { Args: { p_org: string }; Returns: Json };
      platform_me: { Args: Record<string, never>; Returns: Json };
      platform_list_orgs: {
        Args: { p_search?: string | null; p_status?: string | null; p_plan?: string | null; p_limit?: number; p_offset?: number };
        Returns: Json;
      };
      platform_org: { Args: { p_org: string }; Returns: Json };
      platform_update_subscription: {
        Args: { p_org: string; p_plan_key: string; p_seats: number | null; p_trial_ends_at: string | null; p_reason: string };
        Returns: undefined;
      };
      platform_set_overrides: { Args: { p_org: string; p_limits: Json; p_features: Json; p_reason: string }; Returns: undefined };
      platform_set_org_status: { Args: { p_org: string; p_status: OrgStatus; p_reason: string }; Returns: undefined };
      platform_update_plan: {
        Args: {
          p_key: string;
          p_name_he: string;
          p_price_monthly_agorot: number;
          p_price_annual_agorot: number;
          p_limits: Json;
          p_features: Json;
          p_is_public: boolean;
        };
        Returns: undefined;
      };
      platform_metrics: { Args: Record<string, never>; Returns: Json };
      platform_staff_list: { Args: Record<string, never>; Returns: Json };
      platform_set_staff: { Args: { p_email: string; p_role: PlatformRole | null }; Returns: undefined };
      platform_log_list: { Args: { p_org?: string | null; p_limit?: number }; Returns: Json };
      platform_open_support: { Args: { p_org: string }; Returns: string };
      // service-role only (the app's push dispatcher)
      claim_push_notifications: {
        Args: { p_limit?: number };
        // [{ id, organization_id, user_id, title, body, entity_type, entity_id, organization_name }]
        Returns: Json;
      };
      // stored files of deleted rows (migration 0021), service role only
      claim_orphan_files: { Args: { p_limit?: number }; Returns: Json };
      // every bucket (USR-01, migration avatar_cleanup): [{ bucket, path }]
      claim_orphan_objects: { Args: { p_limit?: number }; Returns: Json };
      finish_orphan_files: { Args: { p_paths: string[] }; Returns: number };
      run_automation_now: {
        Args: { p_automation_id: string; p_entity_id: string };
        // { status, steps }
        Returns: Json;
      };
      convert_lead: {
        Args: {
          p_lead_id: string;
          p_create_deal?: boolean;
          p_deal_name?: string | null;
          p_amount_agorot?: number;
        };
        Returns: Json;
      };
    };
    Enums: {
      membership_role: MembershipRole;
      membership_status: MembershipStatus;
      seat_type: SeatType;
      org_status: OrgStatus;
      record_visibility: RecordVisibility;
      view_scope: ViewScope;
      subscription_status: SubscriptionStatus;
      billing_cycle: BillingCycle;
      stage_kind: StageKind;
      lead_status_kind: LeadStatusKind;
      task_status: TaskStatus;
    };
    CompositeTypes: { [_ in never]: never };
  };
};
