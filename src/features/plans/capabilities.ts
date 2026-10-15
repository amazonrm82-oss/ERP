// What a plan card lists (owner's pricing, 13 October 2026). One list for the app's
// plan cards and later the landing page's price list (LND-13). `built: false` marks
// a capability not built yet; the card shows it as "בקרוב". The lead flips `built`
// when a requirement is merged.

// `core`: CRM data every plan holds, with no plan key (owner, 14 October 2026); every card lists it.
export type PlanCapability = { feature: string; label: string; built: boolean; core?: true };

export const PLAN_CAPABILITIES: readonly PlanCapability[] = [
  { feature: "billing_details", label: "פרטי חיוב בחברה ובאיש קשר", built: true, core: true },
  // DEAL-07: deal data, no plan key (to be confirmed by the owner)
  { feature: "recurring_revenue", label: "הכנסה חוזרת בעסקאות", built: true, core: true },
  // LEAD-05 (owner, 14 October 2026): core, open in every plan
  { feature: "lead_scoring", label: "ציון ליד לפי כללים", built: true, core: true },
  // DLI-01..02, PL-03: product lines in a deal sit under the products flag (owner, 14 October 2026)
  { feature: "products", label: "קטלוג מוצרים, מחירונים, מוצר מבוקש בליד ושורות מוצר בעסקה", built: true },
  // DSC-01 (line part): a discount on a deal line (owner, 14 October 2026)
  { feature: "discounts", label: "הנחה בשורה", built: true },
  { feature: "quotes", label: "הצעות מחיר וחתימה", built: false },
  { feature: "payment_links", label: "קישורי תשלום", built: false },
  { feature: "balances", label: "כרטסת לקוח", built: false },
  { feature: "booking_page", label: "דפי קביעת תור", built: false },
  { feature: "money_waiting", label: "כסף שמחכה", built: true },
  { feature: "instant_reply", label: "מענה מיידי ללקוח", built: false },
  { feature: "email_sync", label: "סנכרון אימייל ויומן", built: false },
  { feature: "whatsapp_inbox", label: "תיבת WhatsApp (ההודעות מהארנק)", built: false },
  { feature: "goals", label: "יעד לעסק", built: true },
  { feature: "auto_reassign", label: "העברה אוטומטית של ליד לנציג הבא", built: true },
  { feature: "orders", label: "מודול הזמנות", built: false },
  { feature: "api", label: "API ו-webhooks", built: false },
  { feature: "custom_reports", label: "דוחות מותאמים", built: false },
  { feature: "dashboards", label: "דשבורדים", built: false },
  { feature: "goals_per_rep", label: "יעד לכל נציג ולכל צוות", built: true },
  { feature: "custom_roles", label: "תפקידים מותאמים", built: false },
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
  return PLAN_CAPABILITIES.filter((item) => item.core === true || flags[item.feature] === true);
}

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
