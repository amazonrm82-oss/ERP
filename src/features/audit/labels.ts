// Hebrew names for what the audit log records.

import { GOAL_METRICS, GOAL_PERIOD_LABELS, GOAL_SCOPE_LABELS } from "@/features/goals/metrics";

export const ENTITY_LABELS: Record<string, string> = {
  leads: "ליד",
  contacts: "איש קשר",
  companies: "חברה",
  deals: "עסקה",
  tasks: "משימה",
  // CAL-01
  meetings: "פגישה",
  meeting_participants: "משתתף בפגישה",
  files: "קובץ",
  // REC-05: a note, call or meeting edited or deleted in a record's timeline
  activities: "רשומה בציר הזמן",
  organizations: "פרטי העסק",
  memberships: "משתמש",
  invitations: "הזמנה",
  teams: "צוות",
  team_members: "חברות בצוות",
  pipelines: "תהליך מכירה",
  stages: "שלב",
  field_definitions: "שדה מותאם",
  // LEAD-06
  conversion_field_maps: "העברת שדה בהמרת ליד",
  // LEAD-03
  disqualify_reasons: "סיבה לליד לא רלוונטי",
  deal_loss_reasons: "סיבת הפסד",
  // CON-03 follow-up
  deal_contact_roles: "תפקיד בעסקה",
  // CON-06
  contact_relation_types: "סוג קשר בין אנשי קשר",
  // CAL-08
  meeting_types: "סוג פגישה",
  // CAL-10
  booking_pages: "דף קביעת תור",
  segments: "סגמנט",
  business_cards: "כרטיס ביקור",
  // BIZ-03
  qr_codes: "קוד QR",
  // SPD-07
  site_widgets: "כפתור באתר",
  checklist_templates: "תבנית רשימת תיוג",
  // WA-01
  whatsapp_templates: "תבנית WhatsApp",
  // GOL-01
  goals: "יעד",
  // CON-02
  record_type_options: "סוג איש קשר או חברה",
  subscriptions: "מנוי",
  support_access_grants: "גישת תמיכה",
  automations: "אוטומציה",
  forms: "טופס",
  org_calendar_settings: "שעות וימי מנוחה",
  // CAP-09
  member_leaves: "חופשה של משתמש",
  profiles: "פרופיל משתמש",
  // TAX-01, TAX-02
  org_document_settings: "מע\"מ ופרטים למסמכים",
  // TAX-02 follow-up (the account number is stored masked)
  org_bank_details: "פרטי הבנק של העסק",
  // PRD-04
  product_categories: "קטגוריית מוצרים",
  product_units: "יחידת מידה",
  // PRD-01
  products: "מוצר",
  // PRD-06
  product_costs: "עלות של מוצר",
  // PRD-06 follow-up
  deal_line_costs: "עלות של שורה בעסקה",
  // PL-01
  price_lists: "מחירון",
  // PL-02
  price_list_lines: "מחיר במחירון",
  // DLI-01
  deal_lines: "שורת מוצר בעסקה",
  // QUO-01, QUO-02
  quotes: "הצעת מחיר",
  quote_lines: "שורה בהצעת מחיר",
  // GAP-09
  quote_payment_steps: "תשלום בלוח התשלומים של הצעה",
  // QUO-04
  quote_templates: "תבנית הצעת מחיר",
  quote_template_lines: "שורה בתבנית הצעת מחיר",
  // QUO-05
  quote_designs: "עיצוב הצעת מחיר",
  // DQL-01
  completeness_settings: "שדות חשובים",
  // FLD-08
  card_layouts: "תצוגת כרטיס",
  // CAP-10
  lead_response_settings: "יעד זמן תגובה",
  // QUO-03
  number_sequences: "מספור הצעות והזמנות",
  // LEAD-05
  lead_score_rules: "כלל ציון ליד",
  // CAP-08
  lead_distribution_settings: "חלוקת לידים",
  lead_routing_rules: "כלל חלוקת לידים",
  // PRM-01 (entity_id is the user)
  member_permissions: "הרשאות נוספות של משתמש",
  reports: "דוח",
  full_export: "כל נתוני העסק",
};

export const ACTION_LABELS: Record<string, string> = {
  insert: "יצירה",
  update: "עדכון",
  delete: "מחיקה לצמיתות",
  trash: "העברה לסל המחזור",
  restore: "שחזור מסל המחזור",
  support_open: "כניסת צוות התמיכה (צפייה)",
  mfa_recovery: "כניסה עם קוד גיבוי (אפליקציית האימות הוסרה)",
  mfa_reset: "איפוס אימות דו-שלבי",
  erase: "מחיקת פרטים מהיומן (בקשת פרטיות)",
  export: "ייצוא",
  // PRV-02: everything about one person, in one file
  person_export: "ייצוא כל המידע על האדם",
  // QUO-03: an owner or admin moved the next number of a series forward
  number_jump: "קפיצה קדימה במספור",
  // FLD-09: a deleted pipeline took the conditions based on it (app.pipeline_conditions_cleanup)
  conditions_removed: "הסרת תנאים של שדות",
};

export const LOGIN_ACTION_LABELS: Record<string, string> = {
  login: "כניסה",
  logout: "יציאה",
  user_recovery_requested: "בקשה לאיפוס סיסמה",
  user_updated_password: "שינוי סיסמה",
  user_modified: "שינוי בחשבון",
  token_revoked: "ניתוק חיבור",
};

// fields that are noise in a change list
export const HIDDEN_FIELDS = new Set(["id", "organization_id", "created_at", "created_by", "custom_fields", "tag_ids", "import_job_id",
  // DEAL-03: the reason's name is logged as lost_reason in the same change
  "lost_reason_id"]);

export const FIELD_LABELS: Record<string, string> = {
  // PRV-02 (person_export)
  file_count: "קבצים",
  // QUO-03 jump forward
  next_number: "המספר הבא",
  // FLD-09: a custom field's show / require condition, and the mark a deleted pipeline leaves
  condition: "תנאי",
  condition_removed_at: "התנאי הוסר (תהליך המכירה נמחק)",
  prefix: "קידומת",
  start_number: "מספר התחלתי",
  // PRM-01
  permissions: "הרשאות נוספות",
  // CAP-09
  working_hours: "שעות עבודה",
  // CAP-10
  target_minutes: "יעד בדקות",
  breach_action: "פעולה בחריגה",
  // CAP-08
  method: "שיטת חלוקה",
  weights: "משקלים",
  product_id: "מוצר",
  position: "מיקום ברשימה",
  locale: "שפה",
  preferred_locale: "שפה מועדפת",
  field_key: "שדה",
  field_value: "ערך בשדה",
  starts_on: "מתאריך",
  ends_on: "עד תאריך",
  // HEB-08
  deputy_id: "ממלא מקום",
  // LEAD-05: the rule's parts (the lead's score is never in the audit log)
  points: "נקודות",
  op: "תנאי",
  field: "שדה",
  value: "ערך",
  full_name: "שם",
  first_name: "שם פרטי",
  last_name: "שם משפחה",
  name: "שם",
  phone: "טלפון",
  email: "אימייל",
  company_name: "חברה",
  job_title: "תפקיד",
  status_id: "סטטוס",
  source_id: "מקור",
  owner_id: "אחראי",
  team_id: "צוות",
  stage_id: "שלב",
  pipeline_id: "תהליך מכירה",
  amount_agorot: "סכום",
  status: "מצב",
  deleted_at: "סל המחזור",
  title: "כותרת",
  due_at: "תאריך יעד",
  role: "תפקיד",
  record_visibility: "מי רואה רשומות",
  require_mfa: "חובת אימות דו-שלבי",
  setup_step: "שלב באשף ההקמה",
  setup_checklist_hidden_at: "רשימת ההקמה הוסתרה",
  expected_close_date: "תאריך סגירה צפוי",
  lost_reason: "סיבת הפסד",
  competitor: "מתחרה",
  // DEAL-07: recurring revenue
  billing_kind: "סוג עסקה",
  recurring_amount_agorot: "סכום חוזר",
  recurring_start_date: "תאריך התחלה",
  renewal_date: "תאריך חידוש",
  amount_auto: "שווי מחושב",
  // DLI-03: the deal value from its product lines
  amount_source: "מקור השווי",
  recurring_amount_auto: "סכום חוזר לפי שורות המוצר",
  // GOL-01: a goal
  target: "יעד",
  metric: "מדד",
  period: "תקופה",
  period_start: "תחילת התקופה",
  scope: "יעד של",
  message: "הודעה",
  campaign: "קמפיין",
  // LEAD-01: budget and the UTM values of a lead (a utm change is listed key by key)
  budget_agorot: "תקציב",
  utm: "פרמטרי UTM",
  "utm.utm_source": "UTM: מקור",
  "utm.utm_medium": "UTM: ערוץ",
  "utm.utm_campaign": "UTM: קמפיין",
  "utm.utm_term": "UTM: מילת חיפוש",
  "utm.utm_content": "UTM: מודעה",
  "utm.extra": "פרמטרי קמפיין נוספים",
  converted_at: "הומר",
  converted_contact_id: "איש קשר מההמרה",
  converted_company_id: "חברה מההמרה",
  converted_deal_id: "עסקה מההמרה",
  contact_id: "איש קשר",
  company_id: "חברה",
  deal_id: "עסקה",
  lead_id: "ליד",
  probability: "סיכוי",
  color: "צבע",
  rot_days: "ימים מרביים בשלב",
  snoozed_until: "נדחתה עד",
  closed_at: "נסגרה",
  completed_at: "הושלמה",
  is_available: "זמין ללידים",
  revoked_at: "בוטלה",
  expires_at: "בתוקף עד",
  website: "אתר",
  // CON-09
  company_matched_domain: "שויך לחברה לפי דומיין האימייל",
  company_match_kind: "אופן השיוך לפי דומיין",
  contact_domain_off: "דומיין לפי אנשי הקשר כבוי",
  city: "עיר",
  tax_id: "ח.פ. / מספר רישום",
  country: "מדינת הרישום",
  type_id: "סוג",
  birth_date: "יום הולדת",
  disqualify_reason: "סיבת פסילה",
  first_contacted_at: "מגע ראשון",
  last_contacted_at: "מגע אחרון",
  body: "טקסט",
  occurred_at: "מועד",
  metadata: "פרטים נוספים",
  description: "תיאור",
  // CAL-01: meetings and their participants
  meeting_type: "אופן הפגישה",
  // CAL-08: the business's meeting type, and the type's own fields
  meeting_type_id: "סוג פגישה",
  // CAL-09
  series_id: "סדרת פגישות",
  series_index: "מספר בסדרה",
  meeting_format: "אופן הפגישה",
  buffer_before_minutes: "מרווח לפני (דקות)",
  buffer_after_minutes: "מרווח אחרי (דקות)",
  // GAP-07
  is_block: "זמן חסום",
  starts_at: "התחלה",
  ends_at: "סיום",
  location: "מיקום",
  video_url: "קישור לשיחת הווידאו",
  outcome: "תוצאה",
  // CAL-06
  reminder_minutes: "תזכורת (דקות לפני הפגישה)",
  meeting_id: "פגישה",
  user_id: "משתמש",
  // team members (CAP-06: primary team)
  is_manager: "מנהל הצוות",
  is_primary: "צוות ראשי",
  // CON-01: the type of a contact's primary phone and email, and its further ones
  phone_type: "סוג הטלפון",
  email_type: "סוג האימייל",
  extra_phone: "טלפון נוסף",
  // CON-05: a further company of the contact, with the role there
  company_link: "חברה מקושרת",
  // CON-06: this contact's relation to another one (the phrase of its side; the other person is not named)
  relation: "קשר לאיש קשר אחר",
  reverse_name: "הקשר מהצד השני",
  extra_email: "אימייל נוסף",
  // PRD-01, PRD-04 (products, product categories and units)
  sku: 'מק"ט',
  kind: "סוג",
  barcode: "ברקוד",
  category_id: "קטגוריה",
  unit_id: "יחידת מידה",
  vat_kind: 'מע"מ',
  billing: "חיוב",
  price_agorot: "מחיר",
  cost_agorot: "עלות ליחידה",
  price_includes_vat: 'המחיר כולל מע"מ',
  duration_minutes: "משך בדקות",
  is_active: "פעיל",
  // CAL-10: a booking page
  token: "קישור",
  intro: "הסבר",
  min_notice_minutes: "התראה מינימלית בדקות",
  max_days_ahead: "ימים קדימה",
  slot_step_minutes: "זמני התחלה כל (דקות)",
  questions: "שאלות מקדימות",
  archived_at: "ארכיון",
  parent_id: "קטגוריה ראשית",
  // LEAD-06: a conversion mapping (ids; the screen names the fields)
  lead_field_id: "שדה בליד",
  target_type: "עובר אל",
  target_field_id: "שדה יעד",
};

/** Hebrew for coded values, by field (GOL-01: a goal's metric, scope and period). */
export const VALUE_LABELS: Record<string, Record<string, string>> = {
  metric: Object.fromEntries(GOAL_METRICS.map((m) => [m.key, m.label])),
  scope: GOAL_SCOPE_LABELS,
  period: GOAL_PERIOD_LABELS,
  // LEAD-06
  target_type: { contact: "איש קשר", deal: "עסקה" },
  // DEAL-07 (null = one-time shows as empty)
  billing_kind: { monthly: "חודשית", yearly: "שנתית" },
  amount_source: { lines: "שורות המוצר", first_year: "שנה ראשונה" },
};
