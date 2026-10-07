// Notification kinds a user can choose for (migration 0031). 'system' (security
// notices) always arrives and is not listed.
export const NOTIFICATION_KINDS = [
  { key: "assigned", label: "רשומה או משימה הוקצתה לי" },
  { key: "task_reminder", label: "תזכורות למשימות" },
  { key: "inquiry", label: "ליד או איש קשר פנו שוב" },
  { key: "automation", label: "התראות מאוטומציות" },
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]["key"];

// per kind: in the bell and on the phone, in the bell only, or not at all
export type DeliveryChoice = "all" | "bell" | "off";

export type NotificationSettings = Record<NotificationKind, DeliveryChoice>;

export function isNotificationKind(value: string): value is NotificationKind {
  return NOTIFICATION_KINDS.some((k) => k.key === value);
}
