// What a plan card lists (owner's pricing, 13 October 2026). One list for the app's
// plan cards and later the landing page's price list (LND-13). `built: false` marks
// a capability not built yet; the card shows it as "בקרוב". The lead flips `built`
// when a requirement is merged.

// `core`: CRM data every plan holds, with no plan key (owner, 14 October 2026); every card lists it.
export type PlanCapability = { feature: string; label: string; built: boolean; core?: true };

export const PLAN_CAPABILITIES: readonly PlanCapability[] = [
  { feature: "billing_details", label: "פרטי חיוב בחברה ובאיש קשר", built: true, core: true },
  // CON-05 (owner, 15 October 2026): core, open in every plan
  { feature: "contact_companies", label: "איש קשר בכמה חברות, עם תפקיד בכל אחת", built: true, core: true },
  // CON-06 (owner, 15 October 2026): core, open in every plan
  { feature: "contact_relations", label: "קשרים בין אנשי קשר ודוח הפניות", built: true, core: true },
  // DEAL-07: deal data, no plan key (to be confirmed by the owner)
  { feature: "recurring_revenue", label: "הכנסה חוזרת בעסקאות", built: true, core: true },
  // LEAD-05 (owner, 14 October 2026): core, open in every plan
  { feature: "lead_scoring", label: "ציון ליד לפי כללים", built: true, core: true },
  // LIB-01 (owner, 3 November 2026, answer (69) א): core, open in every plan, inside the storage quota
  { feature: "content_library", label: "ספריית תוכן: קבצים וקישורים לשליחה ללקוחות", built: true, core: true },
  // DQL-03 (owner, 2 November 2026, answer (60) א): core, open in every plan
  { feature: "cleanup_suggestions", label: "הצעות ניקוי שבועיות: כפילויות, רשומות בלי אחראי ובלי דרך קשר", built: true, core: true },
  // MNY-04 (owner, 11 November 2026, answer (273)): core, open in every plan
  { feature: "anomaly_alerts", label: "התראות על חריגה: ירידה בפניות ממקור, חבר צוות שלא עדכן, טופס שהפסיק וקמפיין שהתייקר", built: true, core: true },
  // CAL-08: a managed list of the calendar, no plan key (owner, 15 October 2026)
  { feature: "meeting_types", label: "סוגי פגישה עם משך, מרווח וצבע", built: true, core: true },
  // DLI-01..02, PL-03: product lines in a deal sit under the products flag (owner, 14 October 2026)
  { feature: "products", label: "קטלוג מוצרים, מחירונים, מוצר מבוקש בליד ושורות מוצר בעסקה", built: true },
  // DSC-01 (line part): a discount on a deal line (owner, 14 October 2026)
  { feature: "discounts", label: "הנחה בשורה", built: true },
  // QUO-01..17
  { feature: "quotes", label: "הצעות מחיר וחתימה", built: true },
  // DOC-01: invoices and receipts issued outside the system
  { feature: "documents", label: "רישום חשבוניות וקבלות", built: true },
  // PAY-01/05/06
  { feature: "payments", label: "רישום תשלומים שהתקבלו", built: true },
  // COL-05
  { feature: "collection", label: "סימון \"לא למכור עד הסדרת חוב\"", built: true },
  { feature: "payment_links", label: "קישורי תשלום", built: false },
  // BAL-01: the customer's ledger on the contact and company pages
  { feature: "balances", label: "כרטסת לקוח", built: true },
  { feature: "booking_page", label: "דפי קביעת תור", built: true },
  // BIZ-02
  { feature: "business_card", label: "כרטיס ביקור דיגיטלי", built: true },
  // BIZ-01 (owner, 3 November 2026, answer (70) ב): every plan, its own key
  { feature: "public_page", label: "דף עסק ציבורי", built: true },
  // BIZ-03 part one: codes that open a form or a booking page, with scan counts
  { feature: "qr_codes", label: "קודי QR לטופס ולקביעת תור, עם ספירת סריקות", built: true },
  // SPD-07
  { feature: "site_widget", label: "כפתור צף לאתר: WhatsApp, חיוג וטופס קצר", built: true },
  { feature: "money_waiting", label: "כסף שמחכה", built: true },
  { feature: "instant_reply", label: "מענה מיידי ללקוח", built: true },
  { feature: "email_sync", label: "סנכרון אימייל ויומן", built: false },
  { feature: "whatsapp_inbox", label: "תיבת WhatsApp (ההודעות מהארנק)", built: false },
  { feature: "goals", label: "יעד לעסק", built: true },
  // SEG-03 (owner, 2 November 2026, answer (61) ב): the plans that hold lead_distribution
  { feature: "campaign_costs", label: "עלויות קמפיינים, עלות לליד והחזר על ההשקעה", built: true },
  // PKG-01, PKG-02 (owner, 3 November 2026, answer (66) ג): basic and up
  { feature: "punch_cards", label: "כרטיסיות: מספר כניסות, תוקף ויתרה ללקוח", built: true },
  // SEG-01
  { feature: "segments", label: "סגמנטים של לידים ואנשי קשר", built: true },
  { feature: "auto_reassign", label: "העברה אוטומטית של ליד לנציג הבא", built: true },
  // CAP-08
  { feature: "lead_distribution", label: "חלוקת לידים לפי משקל, עומס וכללים", built: true },
  // CAP-11 (owner, 8 November 2026, answer (143) ב): the plans that hold lead_distribution
  { feature: "meta_leads", label: "לידים מפייסבוק ואינסטגרם", built: true },
  // CAL-12 (owner, 9 November 2026, answer (178) ב): the plans that hold lead_distribution
  { feature: "meeting_reminders", label: "אישור ותזכורות פגישה ללקוח ב-SMS ובאימייל", built: true },
  // SGN-01 (owner, 3 November 2026, answer (67) ג): basic and up; templates (SGN-01), sending and signing (SGN-02) are built
  { feature: "signatures", label: "תבניות מסמך וחתימה דיגיטלית", built: true },
  // SMS (owner (210) ב): every SMS to a customer, with the plan's month quota
  { feature: "sms", label: "הודעות SMS ללקוחות, עם מכסה חודשית", built: true },
  // RET-02 (owner, 11 November 2026, answer (273)): basic and up
  { feature: "review_requests", label: "בקשת ביקורת ב-Google אחרי עסקה או פגישה", built: true },
  { feature: "orders", label: "מודול הזמנות", built: true },
  { feature: "api", label: "API ו-webhooks", built: false },
  { feature: "custom_reports", label: "דוחות מותאמים", built: false },
  { feature: "dashboards", label: "דשבורדים", built: false },
  { feature: "goals_per_rep", label: "יעד לכל נציג ולכל צוות", built: true },
  { feature: "custom_roles", label: "תפקידים מותאמים", built: false },
  // PRM-01
  { feature: "granular_permissions", label: "הרשאות נקודתיות למשתמש", built: true },
  { feature: "view_seats", label: "מושבי צפייה", built: true },
  { feature: "telephony", label: "טלפוניה", built: false },
  { feature: "custom_objects", label: "אובייקטים מותאמים", built: false },
  { feature: "remove_built_with", label: "בלי השורה \"נבנה ב-Mexuz\"", built: true },
  { feature: "field_permissions", label: "הרשאות לרמת שדה", built: false },
  { feature: "sso", label: "כניסה ארגונית (SSO)", built: false },
];

/** The capabilities a plan includes, in list order, from its plans.features. */
export function planCapabilities(features: unknown): PlanCapability[] {
  const flags = features && typeof features === "object" && !Array.isArray(features) ? (features as Record<string, unknown>) : {};
  return PLAN_CAPABILITIES.filter((item) => item.core === true || flags[item.feature] === true).map((item) =>
    // owner (330) א: without its row actions the screen is read only (the free plan), and the card says so
    item.feature === "money_waiting" && flags.money_waiting_actions !== true ? { ...item, label: MONEY_WAITING_READ_ONLY_LABEL } : item,
  );
}

/** The card's line for "כסף שמחכה" in a plan without `money_waiting_actions`. */
export const MONEY_WAITING_READ_ONLY_LABEL = "כסף שמחכה (לקריאה בלבד)";

// The "עסקי" plan opens when these are built (owner, 13 October 2026). The lead
// flips `built` at merge; then the admin panel says the plan can be opened.
export const BUSINESS_PLAN_PREREQUISITES: readonly { id: string; built: boolean }[] = [
  { id: "PRM-06", built: false },
  { id: "USR-15", built: false },
];

/** Whether the admin panel shows "אפשר לפתוח את החבילה 'עסקי'". */
export function businessPlanCanOpen(availability: string | null | undefined): boolean {
  return availability === "coming_soon" && BUSINESS_PLAN_PREREQUISITES.every((item) => item.built);
}
