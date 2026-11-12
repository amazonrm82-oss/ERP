import type { RoadmapStatus } from "./items";

// Changes to this list need the owner's approval (DECISIONS.md, answer 192).
//
// TRU-01: the public roadmap page (/help/roadmap). A static list in the code, written by the Mexuz team, so the public
// page reads nothing from the database (no service key, no visitor input). Titles and status only: no dates, no
// descriptions, no vote counts (votes are cast and counted inside the system, by signed-in businesses).

export type PublicRoadmapItem = { key: string; title: string; status: Exclude<RoadmapStatus, "done"> };

export const PUBLIC_ROADMAP_ITEMS: readonly PublicRoadmapItem[] = [
  { key: "provider-messages", title: "שליחת מיילים ו-SMS ללקוחות מתוך המערכת", status: "building" },
  { key: "meta-leads", title: "לידים מפייסבוק ומאינסטגרם ישר למערכת", status: "building" },
  { key: "meeting-messages", title: "תזכורות ואישורי פגישה ללקוחות ב-SMS", status: "building" },
  { key: "seasonal-pause", title: "השהיית מנוי לעסק עונתי", status: "planned" },
];

/** The line under the public list (owner, answer 192). */
export const PUBLIC_ROADMAP_NOTE = "הסדר והזמנים עשויים להשתנות";
