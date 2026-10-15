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

// DQL-01 (migration record_completeness): one row per organization and record type (lead | contact | company | deal);
// fields = built-in keys or "cf:<key>" (src/features/data-quality/completeness.ts)
export type CompletenessSettingsRow = {
  id: string;
  organization_id: string;
  object_type: string;
  fields: string[];
  created_at: string;
  updated_at: string;
};

// FLD-08: the groups of the record details card per organization and type; groups = [{title, columns, fields}]. No row = default.
export type CardLayoutRow = {
  id: string;
  organization_id: string;
  object_type: string;
  groups: Json;
  created_at: string;
  updated_at: string;
};

// LEAD-05: one lead score rule; field = a built-in key, cf:<key> or activity:<type> (src/features/lead-score/rules.ts)
export type LeadScoreRuleRow = {
  id: string;
  organization_id: string;
  field: string;
  // "filled" | "empty" | "eq" | "neq" | "gte" | "lte" (check constraint)
  op: string;
  value: string | null;
  points: number;
  position: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

// PRM-01: the extra permissions of one manager or member (keys of app.member_permission_keys()).
// Clients only read; set_member_permissions() writes.
export type MemberPermissionsRow = {
  id: string;
  organization_id: string;
  user_id: string;
  permissions: string[];
  created_at: string;
  updated_at: string;
  updated_by: string | null;
};

// LEAD-06: where a lead custom field goes on conversion. No row = mode "auto" (same label and type, 0029).
export type ConversionFieldMapRow = {
  id: string;
  organization_id: string;
  lead_field_id: string;
  // "contact" | "deal" (check constraint)
  target_type: string;
  // "auto" (same-label rule) | "none" (not copied) | "field" (target_field_id)
  mode: string;
  target_field_id: string | null;
  // server only: the picked field was deleted (FK set null) and no person has written the row since
  target_removed: boolean;
  created_at: string;
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
  // CAP-09 (migration working_hours_leave): the business's weekly hours (shape of profiles.working_hours); null = no hours limit
  working_hours: Json | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};
type OrgCalendarSettingsWrite = {
  rest_weekdays?: number[];
  holidays_rest?: boolean;
  holiday_eves_rest?: boolean;
  rest_occasions?: string[];
  working_hours?: Json | null;
};

// CAP-09 (migration working_hours_leave): leave / absence of a member, dates in the person's zone, both ends included
export type MemberLeaveRow = {
  id: string;
  organization_id: string;
  user_id: string;
  starts_on: string;
  ends_on: string;
  // HEB-08 (migration absence_deputy): null = a plain leave; 'reserve' = במילואים, 'vacation' = בחופשה (LEAVE_KINDS)
  kind: string | null;
  // HEB-08: who stands in during the absence (an active member, checked by trigger)
  deputy_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// TAX-01 (migration tax_status): the business's tax status, at most one row per organization
export type OrgDocumentSettingsRow = {
  id: string;
  organization_id: string;
  // text with a check: individual | company | partnership | nonprofit | other
  legal_form: string | null;
  // text with a check: licensed | exempt | nonprofit | other; null = not set yet
  vat_status: string | null;
  vat_status_other: string | null;
  other_charges_vat: boolean | null;
  // TAX-02 (migration business_documents_details): the business as documents show it
  legal_name: string | null;
  tax_id: string | null;
  address_line: string | null;
  city: string | null;
  postal_code: string | null;
  phone: string | null;
  email: string | null;
  // TAX-04 (migration prices_include_vat): prices typed and shown including VAT
  prices_include_vat: boolean;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};
// CAP-10 (migration response_target): the response target for a new lead and what happens when it is missed;
// at most one row per organization, no row = 60 minutes / notify
export type LeadResponseSettingsRow = {
  id: string;
  organization_id: string;
  // working minutes, 5..1440
  target_minutes: number;
  // text with a check: notify | pass_on | none
  breach_action: string;
  // SPD-03 (migration lead_pass_on): passes per lead before the managers are only notified, 1..5
  max_passes: number;
  created_at: string;
  updated_at: string;
};
type LeadResponseSettingsWrite = {
  target_minutes?: number;
  breach_action?: string;
  max_passes?: number;
};
// QUO-03 (migration number_sequences): one running series per organization and kind
export type NumberSequenceRow = {
  id: string;
  organization_id: string;
  // text with a check: quote | order
  kind: string;
  // up to 12 characters: letters, digits, - / . _
  prefix: string;
  // 1..999,999,999; fixed once a number was handed out
  start_number: number;
  // server only: the last number handed out, null = none yet
  last_number: number | null;
  created_at: string;
  updated_at: string;
};
type NumberSequenceUpdate = {
  prefix?: string;
  start_number?: number;
};
// CAP-08 (migration lead_distribution): at most one row per organization; no row = round robin
export type LeadDistributionSettingsRow = {
  id: string;
  organization_id: string;
  // text with a check: round_robin | weighted | load
  method: string;
  // {user_id: 1..10}; a member not listed weighs 1
  weights: Json;
  created_at: string;
  updated_at: string;
};
type LeadDistributionSettingsWrite = {
  method?: string;
  weights?: Json;
};
// CAP-08: the first active matching rule (by position) sends a new lead to its team
export type LeadRoutingRuleRow = {
  id: string;
  organization_id: string;
  position: number;
  is_active: boolean;
  source_id: string | null;
  product_id: string | null;
  // follow-ups: a language (CONTACT_LOCALES) and a list field of leads with one of its options
  locale: string | null;
  field_key: string | null;
  field_value: string | null;
  // a team or one person, exactly one of the two
  team_id: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
};
type LeadRoutingRuleWrite = {
  position?: number;
  is_active?: boolean;
  source_id?: string | null;
  product_id?: string | null;
  locale?: string | null;
  field_key?: string | null;
  field_value?: string | null;
  team_id?: string | null;
  user_id?: string | null;
};
// TAX-02 follow-up (migration org_bank_details): owners and admins only
export type OrgBankDetailsRow = {
  id: string;
  organization_id: string;
  bank_name: string | null;
  bank_branch: string | null;
  bank_account: string | null;
  bank_account_name: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};
type OrgBankDetailsWrite = {
  bank_name?: string | null;
  bank_branch?: string | null;
  bank_account?: string | null;
  bank_account_name?: string | null;
};
// TAX-03 (migration vat_rates): platform table, read by every signed-in user, written by no client
export type VatRateRow = {
  id: string;
  effective_from: string;
  // basis points: 1800 = 18%
  rate_bp: number;
  note: string | null;
  // ADM-01: set when the platform owner removed the rate before its day; a cancelled row never counts
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};
type OrgDocumentSettingsWrite = {
  legal_form?: "individual" | "company" | "partnership" | "nonprofit" | "other" | null;
  vat_status?: "licensed" | "exempt" | "nonprofit" | "other" | null;
  vat_status_other?: string | null;
  other_charges_vat?: boolean | null;
  prices_include_vat?: boolean;
  legal_name?: string | null;
  tax_id?: string | null;
  address_line?: string | null;
  city?: string | null;
  postal_code?: string | null;
  phone?: string | null;
  email?: string | null;
};

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
  // CAL-08: the meeting type it was set from (meeting_types); null = none or deleted
  meeting_type_id: string | null;
  // CAL-09: the weekly series it belongs to and its place in it (1..52); null = a single meeting; insert only
  series_id: string | null;
  series_index: number | null;
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
  meeting_type_id?: string | null;
  series_id?: string | null;
  series_index?: number | null;
};

export type MeetingUpdate = Partial<Omit<MeetingInsert, "organization_id" | "series_id" | "series_index">>;

// CAL-08: the kinds of meeting a business holds (migration meeting_types)
export type MeetingTypeRow = {
  id: string;
  organization_id: string;
  name: string;
  duration_minutes: number;
  // a MeetingType value, or null = not set
  meeting_format: string | null;
  location: string | null;
  product_id: string | null;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  // a palette key (stage-colors.ts), or null
  color: string | null;
  position: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type MeetingTypeInsert = {
  organization_id: string;
  name: string;
  duration_minutes?: number;
  meeting_format?: MeetingType | null;
  location?: string | null;
  product_id?: string | null;
  buffer_before_minutes?: number;
  buffer_after_minutes?: number;
  color?: string | null;
  position?: number;
  is_active?: boolean;
};

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
  // migration plan_pricing: the price is per business or per user; hidden | coming_soon | available
  price_unit: string;
  availability: string;
};

export type PlanWaitlistRow = {
  id: string;
  organization_id: string;
  user_id: string;
  plan_key: string;
  created_at: string;
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
  // FLD-04: logo object in the public bucket org-logos (<org id>/<uuid>) and main colour (#rrggbb)
  logo_path: string | null;
  brand_color: string | null;
  // FLD-05: industry templates applied (keys); written only by apply_industry_template()
  industry_templates: string[];
  // USR-04: when an owner or admin closed the setup checklist on the home page; null = shown
  setup_checklist_hidden_at: string | null;
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

// WA-01: the organization's WhatsApp text templates (migration whatsapp_templates).
// kind is set by the seed only ('meeting_reminder' on the default reminder template).
export type WhatsappTemplateRow = {
  id: string;
  organization_id: string;
  name: string;
  body: string;
  position: number;
  kind: string | null;
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
  is_unique: boolean;
  is_read_only: boolean;
  default_value: Json | null;
  condition: Json | null;
  // server only (FLD-09 part B): set by the pipeline cleanup, cleared by trigger field_definitions_condition_mark
  condition_removed_at: string | null;
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
  // CAP-05: WhatsApp button on the thank-you state; phone null = the business phone
  whatsapp_button: boolean;
  whatsapp_phone: string | null;
  whatsapp_text: string | null;
  // SPD-05: the hosted form asks when to call back; the choice creates a call task
  callback_choice: boolean;
  // SPD-05: slots switched off on this form, by start hour ('09', '12', '15', '18')
  callback_slots_off: string[];
  // CON-10: the hosted form asks how the person likes to be contacted
  channel_choice: boolean;
  // CAP-08: the hosted form asks the person's preferred language
  locale_choice: boolean;
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
  // PRM-01: the last person who changed the rule (app.touch_row; not client-writable)
  updated_by: string | null;
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

export type ImportEntity = "lead" | "contact" | "company" | "product" | "deal" | "task";
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
  // CON-09: the file's company column was mapped, so new contacts are not linked by email domain
  maps_company: boolean;
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

// REC-03 (migration 0104): one row per user and followed record; user_id comes from the session
// CON-03: further contacts on a deal, each with an optional role (DEAL_CONTACT_ROLES)
export type DealContactRow = {
  organization_id: string;
  deal_id: string;
  contact_id: string;
  // the old code (decision_maker…); kept and read as a fallback while role_id is empty
  role: string | null;
  // CON-03 follow-up: the role picked from the organization's list (deal_contact_roles)
  role_id: string | null;
  created_at: string;
};

export type RecordFollowerRow = {
  id: string;
  organization_id: string;
  user_id: string;
  lead_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
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
  // CON-08 (migration billing_details): billing details; payment_terms is PaymentTermsKind
  // (src/features/billing/terms.ts) with payment_days for net / eom; price_list_id -> price_lists
  billing_name: string | null;
  billing_address: string | null;
  shipping_address: string | null;
  billing_email: string | null;
  payment_terms: string | null;
  payment_days: number | null;
  price_list_id: string | null;
  // CON-09: true = matched only by its own website or email, not by its contacts' domain; null = on
  contact_domain_off: boolean | null;
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
  // CON-08
  billing_name?: string | null;
  billing_address?: string | null;
  shipping_address?: string | null;
  billing_email?: string | null;
  payment_terms?: string | null;
  payment_days?: number | null;
  price_list_id?: string | null;
  // CON-09: only true or null
  contact_domain_off?: true | null;
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
  // CON-09: the email domain the database linked the company by (server only; cleared when company_id changes)
  company_matched_domain: string | null;
  // CON-09: exact | parent | contacts, how that link was made (server only; cleared with it)
  company_match_kind: string | null;
  source_id: string | null;
  address_line: string | null;
  city: string | null;
  birth_date: string | null;
  // CON-10: null or ContactLocale / ContactChannel (src/features/contacts/preferences.ts), check constraints
  preferred_locale: string | null;
  preferred_channel: string | null;
  // CON-10: form | manual, null while the channel is empty (server only, app.preferred_channel_source())
  preferred_channel_source: string | null;
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
  // CON-01: the type of the primary phone and email (null when cleared or not said)
  // text columns with a check constraint: ContactPhoneType / ContactEmailType
  phone_type: string | null;
  email_type: string | null;
  // CON-08 (migration billing_details): billing details; payment_terms is PaymentTermsKind
  // (src/features/billing/terms.ts) with payment_days for net / eom; price_list_id -> price_lists
  billing_name: string | null;
  billing_tax_id: string | null;
  billing_address: string | null;
  shipping_address: string | null;
  billing_email: string | null;
  payment_terms: string | null;
  payment_days: number | null;
  price_list_id: string | null;
};

// CON-01: further phones and emails of a contact; the primary ones stay on the contact row
export type ContactPhoneType = "mobile" | "work" | "home" | "other";
export type ContactEmailType = "work" | "home" | "other";
export type ContactChannelRow = {
  id: string;
  organization_id: string;
  contact_id: string;
  // "phone" | "email"; label is a ContactPhoneType (an email's: ContactEmailType)
  kind: string;
  label: string;
  // as typed (an email lower-cased); value_e164 is a phone's normalized number, set by trigger
  value: string;
  value_e164: string | null;
  position: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ConsentRow = {
  id: string;
  organization_id: string;
  // orders rows that share a timestamp (the latest per channel is the current state)
  seq: number;
  // exactly one while the record exists; both null after it is purged (subject_* keep its id)
  lead_id: string | null;
  contact_id: string | null;
  // "lead" | "contact" and the record's id, set by trigger
  subject_type: string;
  subject_id: string;
  // ConsentChannel, ConsentState, ConsentSource (src/features/consents/model.ts)
  channel: string;
  state: string;
  source: string;
  wording: string | null;
  method: string | null;
  // HMAC-SHA256 (key app.settings consent_hash_key) of the organization, kind and the record's
  // address at the time, set by trigger; null while the key is missing (filled later by the backfill).
  // Clients may not select it (column grants); compare through consent_current().current_address
  address_hash: string | null;
  // 1 = HMAC-SHA256 keyed with consent_hash_key; a new key or method gets another version
  hash_version: number;
  // a copy made by the lead's conversion (LEAD-07): the lead's entry
  copied_from: string | null;
  // an owner's or admin's manual lift of an opt-out: LiftMethod (src/features/consents/model.ts) and a note
  lift_method: string | null;
  lift_note: string | null;
  recorded_by: string | null;
  created_at: string;
};

export type ContactInsert = {
  organization_id: string;
  import_job_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  phone_type?: ContactPhoneType | null;
  email_type?: ContactEmailType | null;
  job_title?: string | null;
  contact_type?: string | null;
  type_id?: string | null;
  company_id?: string | null;
  source_id?: string | null;
  address_line?: string | null;
  city?: string | null;
  birth_date?: string | null;
  // CON-10
  preferred_locale?: string | null;
  preferred_channel?: string | null;
  owner_id?: string | null;
  team_id?: string | null;
  tag_ids?: string[];
  custom_fields?: Json;
  last_contacted_at?: string | null;
  deleted_at?: string | null;
  // CON-08
  billing_name?: string | null;
  billing_tax_id?: string | null;
  billing_address?: string | null;
  shipping_address?: string | null;
  billing_email?: string | null;
  payment_terms?: string | null;
  payment_days?: number | null;
  price_list_id?: string | null;
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
  // TAX-06 (migration money_currency): the currency of budget_agorot; 'ILS' only for now
  currency: string;
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
  // SPD-01: when someone pressed "I took it" (take_lead() only; cleared when the owner changes)
  taken_at: string | null;
  // LEAD-04: the product the lead asked about (public.products); a person may pick only an offerable one
  requested_product_id: string | null;
  // CON-10: null or ContactChannel (src/features/contacts/preferences.ts); its source is form | manual (server only)
  preferred_channel: string | null;
  preferred_channel_source: string | null;
  // CAP-08: null or ContactLocale (check constraint), copied to the contact on conversion when empty
  preferred_locale: string | null;
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
  // score: server-only since LEAD-05 (set by trigger leads_zz_score)
  budget_agorot?: number | null;
  currency?: "ILS";
  message?: string | null;
  disqualify_reason?: string | null;
  owner_id?: string | null;
  team_id?: string | null;
  tag_ids?: string[];
  custom_fields?: Json;
  first_contacted_at?: string | null;
  last_contacted_at?: string | null;
  deleted_at?: string | null;
  requested_product_id?: string | null;
  // CON-10
  preferred_channel?: string | null;
  // CAP-08: he | ar | en | ru | am | fr | es (CONTACT_LOCALES)
  preferred_locale?: string | null;
};

// DEAL-03: the reasons an organization offers when a deal is lost (migration deal_loss_reasons)
// CON-03 follow-up: the roles a contact may have on a deal, a managed list per organization; key is server-only
export type DealContactRoleRow = {
  id: string;
  organization_id: string;
  name: string;
  key: string | null;
  position: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type DealLossReasonRow = {
  id: string;
  organization_id: string;
  name: string;
  position: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

// PRD-04: product categories (two levels: parent_id null = a top category) and units of measure (migration product_lists)
export type ProductCategoryRow = {
  id: string;
  organization_id: string;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
};

export type ProductUnitRow = {
  id: string;
  organization_id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
};

// PL-01: further price lists (migration price_lists). The default price list is the product's own price.
// valid_from / valid_to are calendar dates (inclusive, both optional).
export type PriceListRow = {
  id: string;
  organization_id: string;
  name: string;
  valid_from: string | null;
  valid_to: string | null;
  is_active: boolean;
  // owner, 13 October 2026: one VAT mode for every price in the list; starts from the business's setting
  // (trigger price_lists_vat) and is locked once the list has lines (hint price_lists:vat_locked)
  prices_include_vat: boolean;
  created_at: string;
  updated_at: string;
};

// PL-02: a price list line (migration price_list_lines): a fixed price (typed with its mode, like a product's price)
// or a discount in basis points off the product's own price, from min_quantity (0 = any quantity).
// price_includes_vat is the list's prices_include_vat for a fixed price, false for a discount (set by trigger).
export type PriceListLineRow = {
  id: string;
  organization_id: string;
  price_list_id: string;
  product_id: string;
  min_quantity: number;
  price_agorot: number | null;
  price_includes_vat: boolean;
  discount_bp: number | null;
  currency: string;
  created_at: string;
  updated_at: string;
};

// DLI-01: a product line on a deal (migration deal_lines). total_agorot, price_includes_vat (one mode per deal),
// vat_exempt (a product line's; a free line's is the person's) and price_list_name are set by trigger deal_lines_check; price_source is product | price_list | manual.
export type DealLineRow = {
  id: string;
  organization_id: string;
  deal_id: string;
  position: number;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price_agorot: number;
  discount_bp: number | null;
  discount_agorot: number | null;
  total_agorot: number;
  price_includes_vat: boolean;
  vat_exempt: boolean;
  price_source: string;
  price_list_id: string | null;
  price_list_name: string | null;
  currency: string;
  // DLI-04: one_time | monthly | quarterly | yearly (trigger deal_lines_billing: a product line's is its
  // product's; a free line's the person's); null = saved before DLI-04, counts in the deal's own period
  billing: string | null;
  created_at: string;
  updated_at: string;
};

// PRD-01: the product catalog (migration products). kind, vat_kind and billing are text with check
// constraints (PRODUCT_KINDS, VAT_KINDS, BILLINGS in src/features/products/schema.ts). archived_at is stamped by trigger.
export type ProductRow = {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  sku: string | null;
  category_id: string | null;
  kind: string;
  unit_id: string | null;
  price_agorot: number;
  price_includes_vat: boolean;
  currency: string;
  vat_kind: string;
  billing: string;
  duration_minutes: number | null;
  barcode: string | null;
  is_active: boolean;
  archived_at: string | null;
  // PRD-05: the import that created the product (set on insert only)
  import_job_id: string | null;
  created_at: string;
  updated_at: string;
};

type ProductWrite = {
  name: string;
  description?: string | null;
  sku?: string | null;
  category_id?: string | null;
  kind?: string;
  unit_id?: string | null;
  price_agorot?: number;
  price_includes_vat?: boolean;
  currency?: string;
  vat_kind?: string;
  billing?: string;
  duration_minutes?: number | null;
  barcode?: string | null;
  is_active?: boolean;
};

// GOL-01: a target per person, team or organization, period and metric (migration goals).
// scope, period and metric are text with check constraints (GoalScope, GoalPeriod, GoalMetric in src/features/goals/metrics.ts).
export type GoalRow = {
  id: string;
  organization_id: string;
  scope: string;
  user_id: string | null;
  team_id: string | null;
  period: string;
  period_start: string;
  metric: string;
  target: number;
  created_at: string;
  updated_at: string;
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
  // set by trigger on insert and on a change of stage; a person cannot write it (deals_sync_stage_entered)
  stage_entered_at: string;
  // postponed: not stuck before this day (org time zone); whoever may edit the deal writes it
  snoozed_until: string | null;
  closed_at: string | null;
  // the picked reason's name (a snapshot, set by trigger), or old free text
  lost_reason: string | null;
  // DEAL-03: the reason picked from the organization's list, and the competitor
  lost_reason_id: string | null;
  competitor: string | null;
  contact_id: string | null;
  company_id: string | null;
  source_id: string | null;
  owner_id: string | null;
  team_id: string | null;
  tag_ids: string[];
  custom_fields: Json;
  // DEAL-11: the deal this follow-up continues; set once by a person (deals_previous_check)
  previous_deal_id: string | null;
  // DEAL-07: null = one-time, 'monthly' | 'yearly'; a recurring deal has an amount (deal's currency) and a start date
  billing_kind: string | null;
  recurring_amount_agorot: number | null;
  recurring_start_date: string | null;
  renewal_date: string | null;
  // DEAL-07: true while the value is computed; set by trigger only (deals_amount_auto)
  amount_auto: boolean | null;
  // DLI-03: what a computed value follows, 'lines' | 'first_year' (null on a row computed before DLI-03: first year)
  amount_source: string | null;
  // DLI-03: true while the recurring amount follows the product lines; set by trigger only
  recurring_amount_auto: boolean | null;
  // IMP-03: the import that created the deal; set on insert only (deals_import_tag)
  import_job_id: string | null;
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
  // null = empty: the database fills it from the product lines or a recurring deal's first year, else 0 (deals_amount_auto)
  amount_agorot?: number | null;
  currency?: string;
  expected_close_date?: string | null;
  // DEAL-04: the close window's date; cleared on an open deal, never more than a day ahead (deals_sync_stage_close)
  closed_at?: string | null;
  lost_reason?: string | null;
  lost_reason_id?: string | null;
  competitor?: string | null;
  contact_id?: string | null;
  company_id?: string | null;
  source_id?: string | null;
  owner_id?: string | null;
  team_id?: string | null;
  tag_ids?: string[];
  custom_fields?: Json;
  snoozed_until?: string | null;
  previous_deal_id?: string | null;
  billing_kind?: string | null;
  // null on a recurring deal = follows the product lines (0 while there are none; DLI-03)
  recurring_amount_agorot?: number | null;
  recurring_start_date?: string | null;
  renewal_date?: string | null;
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
  // IMP-03: the import that created the task; set on insert only (tasks_import_tag, insert grant only)
  import_job_id: string | null;
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
          logo_path?: string | null;
          brand_color?: string | null;
          setup_checklist_hidden_at?: string | null;
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
      // kind is the server's: no insert or update grant on it
      whatsapp_templates: Table<
        WhatsappTemplateRow,
        { organization_id: string; name: string; body: string; position?: number },
        { name?: string; body?: string; position?: number }
      >;
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
          is_unique?: boolean;
          is_read_only?: boolean;
          default_value?: Json | null;
          condition?: Json | null;
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
          whatsapp_button?: boolean;
          whatsapp_phone?: string | null;
          whatsapp_text?: string | null;
          callback_choice?: boolean;
          callback_slots_off?: string[];
          channel_choice?: boolean;
          locale_choice?: boolean;
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
          whatsapp_button?: boolean;
          whatsapp_phone?: string | null;
          whatsapp_text?: string | null;
          callback_choice?: boolean;
          callback_slots_off?: string[];
          channel_choice?: boolean;
          locale_choice?: boolean;
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
        { organization_id: string; entity_type: ImportEntity; file_name: string; duplicate_mode: DuplicateMode; total_rows?: number; maps_company?: boolean },
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
      // followers of a record (migration 0104, REC-03): insert and delete your own rows, no updates
      record_followers: Table<
        RecordFollowerRow,
        { organization_id: string; lead_id?: string | null; contact_id?: string | null; company_id?: string | null; deal_id?: string | null },
        Record<string, never>
      >;
      // "עדכנו אותי כשזה זמין" (migration plan_waitlist); user_id comes from the session
      plan_waitlist: Table<PlanWaitlistRow, { organization_id: string; plan_key: string }, Record<string, never>>;
      // each user's columns per list (migration 0033); user_id comes from the session
      list_preferences: Table<ListPreferencesRow, { organization_id: string; object_type: string; columns?: Json }, { columns?: Json }>;
      companies: Table<CompanyRow, CompanyInsert>;
      contacts: Table<ContactRow, ContactInsert>;
      contact_channels: Table<
        ContactChannelRow,
        { organization_id: string; contact_id: string; kind: "phone" | "email"; label?: ContactPhoneType; value: string; position?: number },
        { label?: ContactPhoneType; value?: string; position?: number }
      >;
      leads: Table<LeadRow, LeadInsert>;
      // marketing consent (CNS-01): append-only; the browser inserts manual entries only
      consents: Table<
        ConsentRow,
        {
          organization_id: string;
          lead_id?: string | null;
          contact_id?: string | null;
          channel: "email" | "sms" | "whatsapp" | "phone";
          state: "granted" | "denied" | "withdrawn" | "unknown";
          source: "manual";
          wording?: string | null;
          method: string;
          lift_method?: "signed_form" | "written_message" | "recorded_call" | null;
          lift_note?: string | null;
        },
        Record<string, never>
      >;
      deals: Table<DealRow, DealInsert & { import_job_id?: string | null }, Partial<DealInsert>>;
      deal_loss_reasons: Table<DealLossReasonRow, { organization_id: string; name: string; position?: number; is_active?: boolean }>;
      // CON-03 follow-up: column grants (key is server-only; organization_id fixed once inserted)
      deal_contact_roles: Table<
        DealContactRoleRow,
        { organization_id: string; name: string; position?: number; is_active?: boolean },
        { name?: string; position?: number; is_active?: boolean }
      >;
      // PRD-04: organization_id is fixed once inserted (column grants)
      product_categories: Table<
        ProductCategoryRow,
        { organization_id: string; name: string; parent_id?: string | null; position?: number },
        { name?: string; parent_id?: string | null; position?: number }
      >;
      // PRD-01: column grants; organization_id is fixed once inserted, archived_at only on update (stamped by trigger)
      products: Table<ProductRow, ProductWrite & { organization_id: string; import_job_id?: string | null }, Partial<ProductWrite> & { archived_at?: string | null }>;
      // PL-01: column grants; organization_id is fixed once inserted
      price_lists: Table<
        PriceListRow,
        { organization_id: string; name: string; valid_from?: string | null; valid_to?: string | null; is_active?: boolean; prices_include_vat?: boolean },
        { name?: string; valid_from?: string | null; valid_to?: string | null; is_active?: boolean; prices_include_vat?: boolean }
      >;
      // PL-02: column grants; the list and the product are fixed once inserted; price_includes_vat comes from the list
      // (trigger price_list_lines_vat), never from the client
      price_list_lines: Table<
        PriceListLineRow,
        {
          organization_id: string;
          price_list_id: string;
          product_id: string;
          min_quantity?: number;
          price_agorot?: number | null;
          discount_bp?: number | null;
          currency?: string;
        },
        { min_quantity?: number; price_agorot?: number | null; discount_bp?: number | null; currency?: string }
      >;
      // DLI-01: column grants; the deal and the product are fixed once inserted; price_includes_vat may be sent on
      // insert only (it must match the deal's mode); the totals and the copied names come from the server
      deal_lines: Table<
        DealLineRow,
        {
          organization_id: string;
          deal_id: string;
          position?: number;
          product_id?: string | null;
          description: string;
          quantity?: number;
          unit_price_agorot?: number;
          discount_bp?: number | null;
          discount_agorot?: number | null;
          price_includes_vat?: boolean;
          // a free line only; a product line's comes from the product (trigger deal_lines_check)
          vat_exempt?: boolean;
          price_source?: string;
          price_list_id?: string | null;
          currency?: string;
          // a free line only; a product line's comes from the product (trigger deal_lines_billing)
          billing?: string | null;
        },
        {
          position?: number;
          description?: string;
          quantity?: number;
          unit_price_agorot?: number;
          discount_bp?: number | null;
          discount_agorot?: number | null;
          vat_exempt?: boolean;
          price_source?: string;
          price_list_id?: string | null;
          currency?: string;
          billing?: string | null;
        }
      >;
      product_units: Table<ProductUnitRow, { organization_id: string; name: string; position?: number }, { name?: string; position?: number }>;
      // GOL-01: who, period and metric are fixed once inserted; only the target changes (column-level update grant)
      goals: Table<
        GoalRow,
        { organization_id: string; scope: string; user_id?: string | null; team_id?: string | null; period: string; period_start: string; metric: string; target: number },
        { target?: number }
      >;
      // CON-03: only the role changes (column-level update grant)
      deal_contacts: Table<
        DealContactRow,
        { organization_id: string; deal_id: string; contact_id: string; role?: string | null; role_id?: string | null },
        { role?: string | null; role_id?: string | null }
      >;
      activities: Table<ActivityRow, ActivityInsert, ActivityUpdate>;
      tasks: Table<TaskRow, TaskInsert & { import_job_id?: string | null }, Partial<TaskInsert>>;
      meetings: Table<MeetingRow, MeetingInsert, MeetingUpdate>;
      meeting_types: Table<MeetingTypeRow, MeetingTypeInsert, Partial<Omit<MeetingTypeInsert, "organization_id">>>;
      meeting_participants: Table<MeetingParticipantRow, { organization_id: string; meeting_id: string; user_id: string }, Record<string, never>>;
      org_calendar_settings: Table<OrgCalendarSettingsRow, OrgCalendarSettingsWrite & { organization_id: string }, OrgCalendarSettingsWrite>;
      // FLD-08: the card layout per record type; no row = the default layout; no delete grant
      card_layouts: Table<CardLayoutRow, { organization_id: string; object_type: string; groups?: Json }, { groups?: Json }>;
      // LEAD-05: owners and admins write; everyone in the business reads
      lead_score_rules: Table<
        LeadScoreRuleRow,
        { organization_id: string; field: string; op: string; value?: string | null; points: number; position?: number; is_active?: boolean },
        { points?: number; position?: number; is_active?: boolean }
      >;
      // DQL-01: the important fields per record type; seeded per organization, no delete grant
      completeness_settings: Table<CompletenessSettingsRow, { organization_id: string; object_type: string; fields?: string[] }, { fields?: string[] }>;
      // CAP-09: the user is inserted once; the dates, kind and deputy change (column-level update grant; HEB-08)
      member_leaves: Table<
        MemberLeaveRow,
        { organization_id: string; user_id: string; starts_on: string; ends_on: string; kind?: string | null; deputy_id?: string | null },
        { starts_on?: string; ends_on?: string; kind?: string | null; deputy_id?: string | null }
      >;
      // LEAD-06: clients insert the identity columns once and update only the target
      conversion_field_maps: Table<
        ConversionFieldMapRow,
        { organization_id: string; lead_field_id: string; target_type: string; mode?: string; target_field_id?: string | null },
        { mode?: string; target_field_id?: string | null }
      >;
      org_document_settings: Table<OrgDocumentSettingsRow, OrgDocumentSettingsWrite & { organization_id: string }, OrgDocumentSettingsWrite>;
      lead_response_settings: Table<LeadResponseSettingsRow, LeadResponseSettingsWrite & { organization_id: string }, LeadResponseSettingsWrite>;
      number_sequences: Table<NumberSequenceRow, NumberSequenceUpdate & { organization_id: string; kind: string }, NumberSequenceUpdate>;
      lead_distribution_settings: Table<LeadDistributionSettingsRow, LeadDistributionSettingsWrite & { organization_id: string }, LeadDistributionSettingsWrite>;
      lead_routing_rules: Table<LeadRoutingRuleRow, LeadRoutingRuleWrite & { organization_id: string }, LeadRoutingRuleWrite>;
      org_bank_details: Table<OrgBankDetailsRow, OrgBankDetailsWrite & { organization_id: string }, OrgBankDetailsWrite>;
      vat_rates: Table<VatRateRow, Record<string, never>, Record<string, never>>;
      // PRM-01: read only; written by set_member_permissions()
      member_permissions: Table<MemberPermissionsRow, Record<string, never>, Record<string, never>>;
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
      report_response_breakdown: { Args: { p_org: string; p_from: string; p_to: string; p_owner?: string | null }; Returns: Json };
      report_rep_performance: { Args: { p_org: string; p_from: string; p_to: string; p_pipeline?: string | null }; Returns: Json };
      report_activity: { Args: { p_org: string; p_from: string; p_to: string; p_owner?: string | null }; Returns: Json };
      report_forecast: { Args: { p_org: string; p_pipeline?: string | null; p_owner?: string | null }; Returns: Json };
      report_meetings: { Args: { p_org: string; p_from: string; p_to: string; p_owner?: string | null }; Returns: Json };
      report_lost_reasons: { Args: { p_org: string; p_from: string; p_to: string; p_pipeline?: string | null; p_owner?: string | null }; Returns: Json };
      report_cycle_length: { Args: { p_org: string; p_from: string; p_to: string; p_pipeline?: string | null; p_owner?: string | null }; Returns: Json };
      report_stuck_deals: { Args: { p_org: string; p_pipeline?: string | null; p_owner?: string | null; p_days?: number }; Returns: Json };
      report_revenue: { Args: { p_org: string; p_from: string; p_to: string; p_pipeline?: string | null; p_owner?: string | null }; Returns: Json };
      report_summary: {
        Args: { p_org: string; p_from: string; p_to: string; p_prev_from: string; p_prev_to: string; p_owner?: string | null };
        Returns: Json;
      };
      // GOL-04: forecast against the goal (migration goal_forecast)
      // DQL-01 (security invoker): [{ id, score, missing }] and { total, rows: [{ id, name, score, missing }] }
      // LEAD-06: the whole conversion mapping screen in one transaction (security invoker)
      save_conversion_field_map: {
        Args: { p_org: string; p_map: Array<{ lead_field_id: string; target_type: string; choice: string }> };
        Returns: { changed: number };
      };
      record_completeness: { Args: { p_org: string; p_type: string; p_ids: string[] }; Returns: Json };
      // LEAD-05: owners/admins recompute one batch now (true = nothing left); members ask whether a recompute waits
      lead_scores_refresh: { Args: { p_org: string }; Returns: boolean };
      lead_scores_pending: { Args: { p_org: string }; Returns: boolean | null };
      // LEAD-05: adds the suggested rules while the business has none; how many were added
      lead_score_rules_suggest: { Args: { p_org: string }; Returns: number };
      // LEAD-05 (security invoker): { score, matched: [{ id, points }] }, or null when the lead cannot be read
      lead_score_breakdown: { Args: { p_org: string; p_lead: string }; Returns: Json };
      incomplete_records: { Args: { p_org: string; p_type: string; p_owner: string; p_limit?: number }; Returns: Json };
      // computed field 0..100 on leads, contacts, companies and deals: used as `order=completeness`, not called as an RPC
      completeness: { Args: Record<string, never>; Returns: number | null };
      // computed field on leads, contacts, companies, deals, tasks and products (FXC-11): the normalized text the lists
      // search, used as a filter (`search_text=like.*…*`), not called as an RPC
      search_text: { Args: Record<string, never>; Returns: string };
      report_goal_forecast: { Args: { p_org: string; p_pipeline?: string | null; p_owner?: string | null }; Returns: Json };
      // MNY-05: open deals that need a decision, stuck or past their close date (migration pipeline_cleanup)
      report_pipeline_cleanup: { Args: { p_org: string; p_owner?: string | null }; Returns: Json };
      // MNY-01: money waiting: deals to close (the cleanup's) and unhandled leads as an estimate (migration money_waiting)
      report_money_waiting: { Args: { p_org: string; p_owner?: string | null }; Returns: Json };
      // GOL-03: progress against the goals the caller reads (migration goal_progress)
      report_goal_progress: {
        Args: { p_org: string; p_period?: string | null; p_period_start?: string | null; p_user?: string | null };
        Returns: Json;
      };
      // account security (migration 0014)
      mfa_required_orgs: { Args: Record<string, never>; Returns: Json };
      // businesses closed to the caller until payment (0161): [{ id, name, status, role }]
      closed_orgs: { Args: Record<string, never>; Returns: Json };
      // a member who is not the owner leaves a business closed until payment (0164)
      leave_closed_organization: { Args: { p_org: string }; Returns: undefined };
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
      // CAP-09: an owner or admin sets a member's working hours (null = the business's)
      set_member_working_hours: { Args: { p_org: string; p_user: string; p_hours: Json | null }; Returns: undefined };
      platform_find_user: { Args: { p_email: string }; Returns: Json };
      platform_reset_mfa: { Args: { p_user: string; p_reason: string; p_check: string }; Returns: undefined };
      // signed agreement (migration 0016)
      sign_agreement: { Args: { p_version: string; p_documents: Json; p_full_name: string; p_method: string; p_signature: string | null }; Returns: string };
      agreement_status: { Args: Record<string, never>; Returns: string | null };
      set_notification_settings: { Args: { p_muted: string[]; p_no_push: string[] }; Returns: undefined };
      // computed fields for sorting lists (migration 0032): used as `order=sort_owner`, not called as RPCs
      sort_status: { Args: Record<string, never>; Returns: number | null };
      sort_source: { Args: Record<string, never>; Returns: string | null };
      // LEAD-04: computed field on leads, the requested product's name (order=sort_requested_product)
      sort_requested_product: { Args: Record<string, never>; Returns: string | null };
      sort_owner: { Args: Record<string, never>; Returns: string | null };
      sort_company: { Args: Record<string, never>; Returns: string | null };
      // deals and tasks lists (migration 0035)
      sort_stage: { Args: Record<string, never>; Returns: number | null };
      sort_contact: { Args: Record<string, never>; Returns: string | null };
      // contacts and companies by type (CON-02)
      sort_type: { Args: Record<string, never>; Returns: number | null };
      // products by category name (PRD-01)
      sort_category: { Args: Record<string, never>; Returns: string | null };
      sort_unit: { Args: Record<string, never>; Returns: string | null };
      // a page's organization context in one call (migration 0028)
      org_context: { Args: { p_org: string }; Returns: Json };
      // plan, limits and usage of a business, members only (migration 0046, FXU-04)
      org_plan_usage: { Args: { p_org: string }; Returns: Json };
      // QUO-03: an owner or admin moves the next number of a series forward; returns the new next number
      number_sequence_jump: { Args: { p_org: string; p_kind: string; p_next: number }; Returns: number };
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
      // sample data (USR-04), owners and admins: { created }; refused while it is there (hint sample:exists)
      sample_data_add: { Args: { p_org: string }; Returns: Json };
      // the records that are sample data, live or in the recycle bin (ids only); removable = still untouched
      // removes the untouched sample records in one transaction (separate, hand-pasted migration): { removed, kept }
      sample_data_remove: { Args: { p_org: string }; Returns: Json };
      sample_data_records: { Args: { p_org: string }; Returns: Array<{ record_type: string; record_id: string; removable: boolean }> };
      // busy times of people in a meeting (CAL-05): id and title only of meetings the caller may read;
      // busy_from / busy_to add the meeting type's buffers (CAL-08)
      // CAL-09: a weekly series made in one transaction (security invoker); { series_id, ids }
      // CAL-09: of the given meetings, the ids the caller could delete now (mirrors meetings_delete)
      meetings_removable: { Args: { p_org: string; p_ids: string[] }; Returns: string[] };
      create_meeting_series: {
        Args: { p_org: string; p_meeting: Json; p_times: Json; p_participants?: string[] };
        Returns: Json;
      };
      meeting_busy: {
        Args: { p_org: string; p_users: string[]; p_from: string; p_to: string; p_exclude?: string | null };
        Returns: Array<{
          user_id: string;
          meeting_id: string | null;
          title: string | null;
          starts_at: string;
          ends_at: string;
          busy_from: string;
          busy_to: string;
        }>;
      };
      // CAL-07: the personal calendar link (migration 0102); calendar_feed_events is service_role only
      calendar_feed_status: { Args: { p_org: string }; Returns: Json };
      calendar_feed_create: { Args: { p_org: string }; Returns: string };
      calendar_feed_revoke: { Args: { p_org: string }; Returns: undefined };
      calendar_feed_events: { Args: { p_token: string }; Returns: Json };
      // GAP-01: a test notification to the caller; { ok: true } | { ok: false, reason: "rate", retry_seconds }
      send_test_notification: { Args: { p_org: string }; Returns: Json };
      // SPD-01: "I took it": { ok: true, result: 'taken' | 'acknowledged' } | { ok: false, reason: 'taken', owner_name } | { ok: false, reason: 'closed' }
      take_lead: { Args: { p_org: string; p_lead: string }; Returns: Json };
      // FLD-05: adds an industry template's missing lists; { added: {...counts}, limits: ["limit:<key>"] }
      apply_industry_template: { Args: { p_org: string; p_industry: string }; Returns: Json };
      // REC-02: who a note on this record may mention (active members who may see it, not the caller)
      mention_candidates: { Args: { p_org: string; p_kind: string; p_id: string }; Returns: Array<{ user_id: string; name: string }> };
      // merging duplicates (migration 0020): picks = { column: "merge" }
      merge_records: { Args: { p_org: string; p_type: string; p_keep: string; p_merge: string; p_picks?: Json }; Returns: undefined };
      my_sessions: { Args: Record<string, never>; Returns: Json };
      org_login_events: { Args: { p_org: string; p_limit?: number }; Returns: Json };
      // privacy erasure (migration 0027)
      audit_erase_candidates: { Args: { p_org: string; p_query: string }; Returns: Json };
      audit_erase_record: { Args: { p_org: string; p_type: string; p_id: string }; Returns: number };
      // -1 = paused until the server can complete it (CNS); p_person_request records "do not contact"
      audit_erase_request: { Args: { p_org: string; p_type: string; p_id: string; p_person_request: boolean }; Returns: number };
      // adds and removes tags on one record (migration 0042)
      change_record_tags: { Args: { p_table: string; p_org: string; p_id: string; p_add: string[]; p_remove: string[] }; Returns: boolean };
      // import duplicates of a chunk, with the caller's rights (migration 0044)
      import_find_duplicates: {
        Args: { p_org: string; p_entity: string; p_phones: string[]; p_emails: string[]; p_tax_ids: string[]; p_names: string[] };
        Returns: Array<{ id: string; phone_e164: string | null; email: string | null; tax_id: string | null; name: string | null }>;
      };
      // PRD-05: products whose SKU (without case) is one of these; security invoker
      product_sku_matches: { Args: { p_org: string; p_skus: string[] }; Returns: Array<{ id: string; sku: string }> };
      // IMP-03: live deals the caller reads whose name equals one of the given ones; security invoker
      deal_name_matches: { Args: { p_org: string; p_names: string[] }; Returns: Array<{ id: string; name: string }> };
      // CON-01: live contacts whose further phones (E.164) or emails match; security invoker
      // CNS-01: the latest entry per channel of a lead or contact (security invoker)
      consent_current: {
        Args: { p_org: string; p_kind: string; p_id: string };
        Returns: Array<{
          channel: string;
          state: string;
          source: string;
          method: string | null;
          wording: string | null;
          recorded_by: string | null;
          created_at: string;
          // null = cannot check (no hash key)
          current_address: boolean | null;
        }>;
      };
      // FLD-07 (migration field_settings): records holding a unique field's value another record holds
      custom_unique_clashes: {
        Args: { p_org: string; p_type: string; p_ids: string[] };
        Returns: Array<{ record_id: string; field_key: string; field_label: string; other_id: string | null }>;
      };
      // CON-09: the one domain two or more of the company's readable live contacts share, else null
      company_contact_domain: { Args: { p_org: string; p_company: string }; Returns: string | null };
      // CON-09: live companies the caller reads with this email's domain, own or from contacts (max 6)
      company_domain_matches: {
        Args: { p_org: string; p_email: string };
        Returns: Array<{ id: string; name: string; domain: string; kind: "exact" | "parent" | "contacts" }>;
      };
      contact_channel_matches: {
        Args: { p_org: string; p_phones: string[]; p_emails: string[] };
        Returns: Array<{ contact_id: string; kind: "phone" | "email"; value: string }>;
      };
      // an exported list goes to the audit log (migration 0034)
      log_export: { Args: { p_org: string; p_kind: string; p_report: string | null; p_rows: number; p_format?: "csv" | "xlsx" }; Returns: undefined };
      // PRM-01: owners and admins set a manager's or member's extra permissions (the whole set)
      set_member_permissions: { Args: { p_org: string; p_user: string; p_permissions: string[] }; Returns: string[] };
      // PRM-01: the keys the caller holds (all for owners and admins)
      my_permissions: { Args: { p_org: string }; Returns: string[] };
      // PRM-01 follow-up: a member with the import permission undoes their own import ({done, kept})
      undo_own_import: { Args: { p_org: string; p_job: string }; Returns: Json };
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
      platform_set_plan_availability: { Args: { p_key: string; p_availability: string }; Returns: undefined };
      // ADM-01: VAT rates from the platform panel (platform owner, future days only)
      platform_add_vat_rate: { Args: { p_effective_from: string; p_rate_bp: number; p_note?: string | null }; Returns: string };
      platform_update_vat_rate: { Args: { p_id: string; p_effective_from: string; p_rate_bp: number; p_note?: string | null }; Returns: string };
      platform_remove_vat_rate: { Args: { p_id: string }; Returns: undefined };
      platform_plan_waitlist: { Args: Record<string, never>; Returns: Json };
      // CNS: hash key and paused erasures, for the panel's alert (platform owner and support)
      platform_consent_health: { Args: Record<string, never>; Returns: Json };
      // BIL-08: the trial-end switch (owner changes it; every platform role reads it)
      platform_trial_end_status: { Args: Record<string, never>; Returns: Json };
      platform_set_trial_end: { Args: { p_enabled: boolean }; Returns: Json };
      // BIL-09 (0162): 'cancelled' 90 days after suspension, OFF by default
      platform_suspension_cancel_status: { Args: Record<string, never>; Returns: Json };
      platform_set_suspension_cancel: { Args: { p_enabled: boolean }; Returns: Json };
      // new-lead notices to the owner of a suspended business (0163), OFF by default
      platform_suspended_lead_notices_status: { Args: Record<string, never>; Returns: Json };
      platform_set_suspended_lead_notices: { Args: { p_enabled: boolean }; Returns: Json };
      // null, or { phase: 'grace' | 'read_only', read_only_on, closes_on } (local YYYY-MM-DD days) for a member
      trial_end_notice: { Args: { p_org: string }; Returns: Json };
      platform_staff_list: { Args: Record<string, never>; Returns: Json };
      platform_set_staff: { Args: { p_email: string; p_role: PlatformRole | null }; Returns: undefined };
      platform_log_list: { Args: { p_org?: string | null; p_limit?: number }; Returns: Json };
      platform_open_support: { Args: { p_org: string }; Returns: string };
      // service-role only (the app's push dispatcher)
      claim_push_notifications: {
        Args: { p_limit?: number };
        // [{ id, organization_id, user_id, title, body, entity_type, entity_id, organization_name, type, lead_actions }]
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
