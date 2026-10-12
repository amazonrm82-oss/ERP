import "server-only";

import { getUserNames } from "@/features/shell/queries";
import type { Json } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { RECORD_TYPES } from "@/lib/record-types";
import { createClient } from "@/lib/supabase/server";

import { CALL_OUTCOME_LABEL, managesTeamChain, SUBJECT_COLUMN, type TimelineFilter, type TimelineSubject } from "./schema";

export type TimelineItem = {
  id: string;
  type: string;
  // short Hebrew label of the activity type
  label: string;
  // user-written text (notes) or a generated sentence (system events)
  text: string;
  isUserContent: boolean;
  // REC-05: the stored text alone, for the edit box
  body: string;
  occurredAt: string;
  authorName: string | null;
  createdBy: string | null;
  // REC-05: the edit window counts from here (set by the database)
  createdAt: string;
  // REC-01: pinned to the top of the timeline
  pinned: boolean;
  // GAP-05: seen only by its author and the owners/admins (the database hides it from everyone else)
  isPrivate: boolean;
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

/**
 * Timeline of a record: pinned entries first, then newest first (100 entries at most).
 * REC-06: with a filter, only activities of those types (pinned ones still on top).
 */
export async function getTimeline(orgId: string, subject: TimelineSubject, filter?: TimelineFilter): Promise<TimelineItem[]> {
  const supabase = await createClient();

  let query = supabase
    .from("activities")
    .select("id, type, body, metadata, occurred_at, created_by, created_at, is_pinned, is_private")
    .eq("organization_id", orgId)
    .eq(SUBJECT_COLUMN[subject.kind], subject.id);
  // the type lists are constants (TIMELINE_FILTERS), never text from the URL
  if (filter?.types) {
    query = query.in("type", [...filter.types]);
  }
  if (filter?.excludeTypes) {
    query = query.not("type", "in", `(${filter.excludeTypes.join(",")})`);
  }
  const { data: activities, error } = await query
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
      body: activity.body ?? "",
      occurredAt: activity.occurred_at,
      authorName: activity.created_by ? (authors.get(activity.created_by) ?? null) : null,
      createdBy: activity.created_by,
      createdAt: activity.created_at,
      pinned: activity.is_pinned,
      isPrivate: activity.is_private,
    };
  });
}

/**
 * REC-01: whether the user manages the team of this record (its team or a parent team), so the
 * timeline shows them the pin button on their team's entries. A hint only: the activities_update
 * policy (app.manages_activity_subject) decides. Only asked for users with the manager role.
 */
export async function managesRecordTeam(orgId: string, subject: TimelineSubject, userId: string): Promise<boolean> {
  const supabase = await createClient();
  const [record, teams, managed] = await Promise.all([
    supabase
      .from(RECORD_TYPES[subject.kind].table as "contacts")
      .select("team_id")
      .eq("organization_id", orgId)
      .eq("id", subject.id)
      .maybeSingle(),
    supabase.from("teams").select("id, parent_team_id").eq("organization_id", orgId),
    supabase.from("team_members").select("team_id").eq("organization_id", orgId).eq("user_id", userId).eq("is_manager", true),
  ]);
  const teamId = must(record, "record team")?.team_id ?? null;
  const managedIds = new Set(must(managed, "managed teams").map((row) => row.team_id));
  if (!teamId || managedIds.size === 0) {
    return false;
  }
  const chain = must(teams, "teams").map((team) => ({ id: team.id, parentTeamId: team.parent_team_id }));
  return managesTeamChain(teamId, chain, managedIds);
}
