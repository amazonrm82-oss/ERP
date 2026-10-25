// Every kind of notification (USR-06, migration 0068). The database checks
// notifications.type and notification_settings against the same list; keep
// the two in step. 'system' (security notices) always arrives and is not listed.
//
// group: where the kind sits on the settings screen.
// shown: false for a kind whose feature is not built yet. It is accepted by
// the database already, and its choice stays "all" until it is shown.
export const NOTIFICATION_KINDS = [
  { key: "assigned", label: "רשומה או משימה הוקצתה לי", group: "records", shown: true },
  { key: "lead_new", label: "ליד חדש נכנס", group: "records", shown: true },
  { key: "inquiry", label: "ליד או איש קשר פנו שוב", group: "records", shown: true },
  { key: "mention", label: "הזכירו אותי בהערה", group: "records", shown: true },
  { key: "follow", label: "עדכונים ברשומות שבמעקב שלי", group: "records", shown: true },
  { key: "response_overdue", label: "ליד מחכה למענה יותר מהזמן שנקבע", group: "records", shown: true },
  { key: "task_reminder", label: "תזכורות למשימות", group: "calendar", shown: true },
  { key: "meeting_scheduled", label: "נקבעה לי פגישה", group: "calendar", shown: true },
  { key: "meeting_reminder", label: "תזכורות לפגישות", group: "calendar", shown: true },
  // CAL-10b: a customer cancelled or moved a meeting through their personal link
  { key: "meeting_cancelled", label: "פגישה שלי בוטלה", group: "calendar", shown: true },
  // QUO-10 (owner, 18 October 2026): the customer opened a quote for the first time
  { key: "quote_viewed", label: "לקוח פתח הצעת מחיר", group: "money", shown: true },
  // QUO-09: the customer accepted or declined a quote (built, so it can be muted too)
  { key: "quote", label: "הצעת מחיר אושרה, נדחתה או פג תוקפה", group: "money", shown: true },
  // PAY-07 (owner, 21 October 2026, answer 4): a payment was received
  { key: "payment", label: "תשלום התקבל", group: "money", shown: true },
  { key: "automation", label: "התראות מאוטומציות", group: "automations", shown: true },
  { key: "automation_failed", label: "אוטומציה נכשלה (למנהלים)", group: "automations", shown: true },
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]["key"];

export type NotificationGroup = (typeof NOTIFICATION_KINDS)[number]["group"];

export const NOTIFICATION_GROUPS: { key: NotificationGroup; label: string }[] = [
  { key: "records", label: "לידים ורשומות" },
  { key: "calendar", label: "משימות ופגישות" },
  { key: "money", label: "הצעות ותשלומים" },
  { key: "automations", label: "אוטומציות" },
];

/** The groups and kinds the settings screen shows; a group with nothing shown is left out. */
export function shownNotificationGroups() {
  return NOTIFICATION_GROUPS.map((group) => ({
    ...group,
    kinds: NOTIFICATION_KINDS.filter((kind) => kind.group === group.key && kind.shown),
  })).filter((group) => group.kinds.length > 0);
}

// per kind: in the bell and on the phone, in the bell only, or not at all
export type DeliveryChoice = "all" | "bell" | "off";

export type NotificationSettings = Record<NotificationKind, DeliveryChoice>;

export function isNotificationKind(value: string): value is NotificationKind {
  return NOTIFICATION_KINDS.some((k) => k.key === value);
}
