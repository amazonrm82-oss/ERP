// Choices of the onboarding form. The stored value is the stable key; the
// label is what the user sees.

export const INDUSTRIES = [
  { value: "services", label: "שירותים מקצועיים וייעוץ" },
  { value: "real_estate", label: "נדל\"ן ותיווך" },
  { value: "insurance_finance", label: "ביטוח ופיננסים" },
  { value: "construction", label: "בנייה, שיפוצים והתקנות" },
  { value: "retail", label: "מסחר וקמעונאות" },
  { value: "health", label: "בריאות, טיפול וקליניקות" },
  { value: "education", label: "חינוך והדרכה" },
  { value: "marketing", label: "שיווק, פרסום ודיגיטל" },
  { value: "technology", label: "טכנולוגיה ותוכנה" },
  { value: "tourism_events", label: "תיירות ואירועים" },
  { value: "nonprofit", label: "עמותות ומלכ\"רים" },
  { value: "other", label: "אחר" },
] as const;

export const TEAM_SIZES = [
  { value: "1", label: "רק אני" },
  { value: "2-5", label: "2 עד 5" },
  { value: "6-15", label: "6 עד 15" },
  { value: "16-50", label: "16 עד 50" },
  { value: "51+", label: "יותר מ-50" },
] as const;
