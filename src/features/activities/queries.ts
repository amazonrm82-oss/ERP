import "server-only";

import { getUserNames } from "@/features/shell/queries";
import type { Json } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

import { CALL_OUTCOME_LABEL, SUBJECT_COLUMN, type TimelineSubject } from "./schema";

export type TimelineItem = {
  id: string;
  type: string;
  // short Hebrew label of the activity type
  label: string;
  // user-written text (notes) or a generated sentence (system events)
  text: string;
  isUserContent: boolean;
  occurredAt: string;
  authorName: string | null;
  createdBy: string | null;
  // REC-01: pinned to the top of the timeline
  pinned: boolean;
};

const TYPE_LABELS: Record<string, string> = {
  note: "הערה",
  call: "שיחה",
  meeting: "פגישה",
  email: "אימייל",
  whatsapp: "WhatsApp",
  sms: "SMS",
  status_change: "שינוי סטטוס",
  stage_change: "שינוי שלב",
  conversion: "המרה",
  assignment: "הקצאה",
  system: "מערכת",
  inquiry: "פנייה חוזרת",
};

function metaString(metadata: Json, key: string): string | null {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = metadata[key];
    return typeof value === "string" ? value : null;
  }
  return null;
}

const TIMELINE_LIMIT = 100;

/** Timeline of a record: pinned entries first, then newest first (100 entries at most). */
export async function getTimeline(orgId: string, subject: TimelineSubject): Promise<TimelineItem[]> {
  const supabase = await createClient();

  const { data: activities, error } = await supabase
    .from("activities")
    .select("id, type, body, metadata, occurred_at, created_by, is_pinned")
    .eq("organization_id", orgId)
    .eq(SUBJECT_COLUMN[subject.kind], subject.id)
    .order("is_pinned", { ascending: false })
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(TIMELINE_LIMIT);
  if (error) {
    throw new Error(`timeline query failed: ${error.message}`);
  }

  // Names behind the ids that system events carry in their metadata.
  const needsStatuses = activities.some((a) => a.type === "status_change");
  const needsStages = activities.some((a) => a.type === "stage_change");
  const [statuses, stages, authors] = await Promise.all([
    needsStatuses
      ? supabase.from("lead_statuses").select("id, name").eq("organization_id", orgId)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
    needsStages
      ? supabase.from("stages").select("id, name").eq("organization_id", orgId)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
    getUserNames(activities.map((a) => a.created_by)),
  ]);
  const statusNames = new Map((statuses.data ?? []).map((row) => [row.id, row.name]));
  const stageNames = new Map((stages.data ?? []).map((row) => [row.id, row.name]));

  return activities.map((activity) => {
    const body = activity.body?.trim() ?? "";
    let text = body;
    let isUserContent = body !== "";

    if (activity.type === "status_change") {
      const from = statusNames.get(metaString(activity.metadata, "from_status_id") ?? "");
      const to = statusNames.get(metaString(activity.metadata, "to_status_id") ?? "");
      text = from && to ? `הסטטוס שונה מ"${from}" ל"${to}".` : "הסטטוס שונה.";
      isUserContent = false;
    } else if (activity.type === "stage_change") {
      const from = stageNames.get(metaString(activity.metadata, "from_stage_id") ?? "");
      const to = stageNames.get(metaString(activity.metadata, "to_stage_id") ?? "");
      text = from && to ? `העסקה עברה מהשלב "${from}" לשלב "${to}".` : "העסקה עברה שלב.";
      isUserContent = false;
    } else if (activity.type === "inquiry") {
      // a repeat submission from a form or webhook: who wrote, through which channel, and what
      // phone and email are wrapped in bidi isolates so they keep their order inside Hebrew text
      const ltr = (value: string | null) => (value ? `\u2066${value}\u2069` : null);
      const who = [metaString(activity.metadata, "full_name"), ltr(metaString(activity.metadata, "phone")), ltr(metaString(activity.metadata, "email"))]
        .filter(Boolean)
        .join(", ");
      const channel = metaString(activity.metadata, "form_name");
      text = [`פנייה נוספת${channel ? ` דרך "${channel}"` : ""}${who ? `: ${who}` : ""}.`, body].filter(Boolean).join("\n");
      isUserContent = false;
    } else if (activity.type === "call" && metaString(activity.metadata, "outcome")) {
      // TASK-02: how the call ended, then the note
      const outcome = CALL_OUTCOME_LABEL[metaString(activity.metadata, "outcome") ?? ""];
      if (outcome) text = body ? `${outcome}. ${body}` : `${outcome}.`;
    } else if (activity.type === "conversion") {
      text = "הליד הומר לאיש קשר.";
      isUserContent = false;
    }

    return {
      id: activity.id,
      type: activity.type,
      label: TYPE_LABELS[activity.type] ?? "פעילות",
      text,
      isUserContent,
      occurredAt: activity.occurred_at,
      authorName: activity.created_by ? (authors.get(activity.created_by) ?? null) : null,
      createdBy: activity.created_by,
      pinned: activity.is_pinned,
    };
  });
}
