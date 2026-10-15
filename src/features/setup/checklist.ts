// The setup checklist (USR-04): what a new business usually does in its first
// days, each item worked out from the business's own data (nothing is ticked by
// hand), with a progress percentage. Sample data never counts as a first lead
// or a first deal. Owners and admins see it; it can be closed
// (organizations.setup_checklist_hidden_at, migration 0104).

import { paths } from "@/lib/paths";

/** What the checklist is worked out from; every fact is read with the user's session. */
export type ChecklistFacts = {
  // the business has a phone and an industry (step 1 and 2 of the setup wizard, or /settings/business)
  detailsFilled: boolean;
  // a lead that is not sample data, not in the recycle bin
  realLead: boolean;
  // an active lead form or webhook
  activeForm: boolean;
  // a deal that is not sample data, not in the recycle bin
  realDeal: boolean;
  // someone besides the caller: another member, or an invitation that was not revoked
  teamInvited: boolean;
  // an import that finished
  importDone: boolean;
  // phone notifications are on for the viewing user (personal)
  pushOn: boolean;
};

export type ChecklistKey = keyof ChecklistFacts;

export type ChecklistItem = {
  key: ChecklistKey;
  title: string;
  hint: string;
  href: string;
  done: boolean;
};

const ITEMS: { key: ChecklistKey; title: string; hint: string; href: (orgId: string) => string }[] = [
  { key: "detailsFilled", title: "פרטי העסק", hint: "טלפון וענף", href: paths.settingsBusiness },
  { key: "realLead", title: "ליד ראשון", hint: "הוסיפו ליד אמיתי, לא לדוגמה", href: paths.leadNew },
  { key: "activeForm", title: "טופס לידים", hint: "לידים מהאתר נכנסים לבד", href: paths.settingsIntake },
  { key: "realDeal", title: "עסקה ראשונה", hint: "עסקה בתהליך מכירה", href: paths.dealNew },
  { key: "teamInvited", title: "הזמנת הצוות", hint: "עובד אחד לפחות", href: paths.settingsUsers },
  { key: "importDone", title: "ייבוא מקובץ", hint: "לקוחות מאקסל או ממערכת קודמת", href: paths.importNew },
  // GAP-01: the item shows this device's state and a test button; it is done when the user has push on in any browser
  { key: "pushOn", title: "קבלת התראות במכשיר הזה", hint: "ליד חדש מגיע אליכם מיד. אפשר לשלוח התראת בדיקה ולראות שהיא מגיעה.", href: paths.notifications },
];

export const CHECKLIST_ITEM_COUNT = ITEMS.length;

export function buildChecklist(orgId: string, facts: ChecklistFacts): ChecklistItem[] {
  return ITEMS.map((item) => ({ key: item.key, title: item.title, hint: item.hint, href: item.href(orgId), done: facts[item.key] }));
}

/** Done items and the percentage, rounded down so 100% means everything is done. */
export function checklistProgress(items: readonly ChecklistItem[]): { done: number; total: number; percent: number } {
  const total = items.length;
  const done = items.filter((item) => item.done).length;
  return { done, total, percent: total === 0 ? 100 : Math.floor((done / total) * 100) };
}

// ---------------------------------------------------------------------------
// Sample data (USR-04): which records are sample data is kept by the database
// (app.sample_records). A sample record is removable only while it is
// untouched; one that someone changed, merged into or linked to is kept.
// The removal is one database call (public.sample_data_remove).
// ---------------------------------------------------------------------------

type NotedRecord = { record_type: string; record_id: string; removable: boolean };

/** How many sample records can be removed in one click, and how many are kept because they were changed. */
export function sampleCounts(rows: readonly NotedRecord[]): { removable: number; kept: number } {
  const removable = rows.filter((row) => row.removable).length;
  return { removable, kept: rows.length - removable };
}

export function keptSampleMessage(kept: number): string {
  return kept === 1
    ? "רשומת דוגמה אחת נשארה כי שינו אותה. אפשר למחוק אותה ידנית."
    : `${kept} רשומות דוגמה נשארו כי שינו אותן. אפשר למחוק אותן ידנית.`;
}
