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
  form_id: string;
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
  // assigned | inquiry | automation | task_reminder ...
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
};

export type CompanyInsert = {
  organization_id: string;
  name: string;
  tax_id?: string | null;
  company_type?: string | null;
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
};

export type ContactInsert = {
  organization_id: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  job_title?: string | null;
  contact_type?: string | null;
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
};

export type LeadInsert = {
  organization_id: string;
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
        }
      >;
      profiles: Table<
        ProfileRow,
        Record<string, never>,
        { full_name?: string | null; phone?: string | null; avatar_url?: string | null; locale?: string }
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
        { organization_id: string; team_id: string; user_id: string; is_manager?: boolean },
        { is_manager?: boolean }
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
      notifications: Table<NotificationRow, Record<string, never>, { read_at?: string | null }>;
      push_subscriptions: Table<
        PushSubscriptionRow,
        // user_id is set by the database from the session
        { endpoint: string; p256dh: string; auth: string; user_agent?: string | null },
        Record<string, never>
      >;
      companies: Table<CompanyRow, CompanyInsert>;
      contacts: Table<ContactRow, ContactInsert>;
      leads: Table<LeadRow, LeadInsert>;
      deals: Table<DealRow, DealInsert>;
      activities: Table<ActivityRow, ActivityInsert, ActivityUpdate>;
      tasks: Table<TaskRow, TaskInsert>;
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
      // service-role only (the app's push dispatcher)
      claim_push_notifications: {
        Args: { p_limit?: number };
        // [{ id, organization_id, user_id, title, body, entity_type, entity_id, organization_name }]
        Returns: Json;
      };
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
