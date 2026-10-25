import "server-only";

import { entryLabel, isActivityBase, type ActivityTypeIcon, type ActivityTypeOption } from "@/features/activity-types/types";
import { getUserNames } from "@/features/shell/queries";
import { DEFAULT_TERMS, type OrgTerms } from "@/features/terminology/terms";
import type { Json } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { RECORD_TYPES } from "@/lib/record-types";
import { createClient } from "@/lib/supabase/server";

import { moneyEntryKind, moneyEntryLabel } from "./money-entries";
import { quoteEntryBy, quoteEntryKind, quoteEntryText } from "./quote-entries";
import { conversionText, responsePassText, stageChangeText } from "./system-entries";
import { CALL_OUTCOME_LABEL, managesTeamChain, SUBJECT_COLUMN, type TimelineFilter, type TimelineSubject } from "./schema";

export type TimelineItem = {
  id: string;
  type: string;
  // short Hebrew label of the activity type (TASK-08: the business's name for a logged kind)
  label: string;
  // TASK-08: the icon of a logged entry's type; null for system events
  icon: ActivityTypeIcon | null;
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
  // AUT-02: written by an automation step; not contact with the customer
  automation_note: "הערה מאוטומציה",
};

function metaString(metadata: Json, key: string): string | null {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = metadata[key];
    return typeof value === "string" ? value : null;
  }
  return null;
}

function metaNumber(metadata: Json, key: string): number | null {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = metadata[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return null;
}

const isResponsePass = (activity: { type: string; metadata: Json }) =>
  activity.type === "system" && metaString(activity.metadata, "kind") === "response_pass";

const TIMELINE_LIMIT = 100;

/**
 * Timeline of a record: pinned entries first, then newest first (100 entries at most).
 * REC-06: with a filter, only activities of those types (pinned ones still on top).
 */
export async function getTimeline(
  orgId: string,
  subject: TimelineSubject,
  filter?: TimelineFilter,
  types: ReadonlyArray<ActivityTypeOption> = [],
  // FLD-10 part three: the business's words in the entries the app draws
  terms: OrgTerms = DEFAULT_TERMS,
): Promise<TimelineItem[]> {
  const supabase = await createClient();

  let query = supabase
    .from("activities")
    .select("id, type, body, metadata, occurred_at, created_by, created_at, is_pinned, is_private, activity_type_id")
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
  // QUO-16: the quotes the entries name, read with the user's session (a quote the user cannot read shows its number only)
  const quoteIds = [
    ...new Set(
      activities
        .filter((a) => quoteEntryKind(a.type, metaString(a.metadata, "kind")))
        .map((a) => metaString(a.metadata, "quote_id"))
        .filter((id): id is string => id !== null),
    ),
  ];
  const [statuses, stages, authors, quotes] = await Promise.all([
    needsStatuses
      ? supabase.from("lead_statuses").select("id, name").eq("organization_id", orgId)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
    needsStages
      ? supabase.from("stages").select("id, name").eq("organization_id", orgId)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
    // SPD-03: the reps a lead was passed between are named from the entry's metadata
    getUserNames([
      ...activities.map((a) => a.created_by),
      ...activities.filter(isResponsePass).flatMap((a) => [metaString(a.metadata, "from_user_id"), metaString(a.metadata, "to_user_id")]),
    ]),
    quoteIds.length > 0
      ? supabase.from("quotes").select("id, title").eq("organization_id", orgId).in("id", quoteIds)
      : Promise.resolve({ data: [] as Array<{ id: string; title: string }>, error: null }),
  ]);
  const quoteTitles = new Map(must(quotes, "timeline quotes").map((row) => [row.id, row.title]));
  const statusNames = new Map((statuses.data ?? []).map((row) => [row.id, row.name]));
  const stageNames = new Map((stages.data ?? []).map((row) => [row.id, row.name]));

  return activities.map((activity) => {
    const body = activity.body?.trim() ?? "";
    let text = body;
    let isUserContent = body !== "";
    const quoteKind = quoteEntryKind(activity.type, metaString(activity.metadata, "kind"));
    const moneyKind = moneyEntryKind(activity.type, metaString(activity.metadata, "kind"));

    if (moneyKind) {
      // DOC-04: written by the database when a document is recorded or cancelled, or a payment received or cancelled
      isUserContent = false;
    } else if (quoteKind) {
      // QUO-16: written by the database when the quote was sent, accepted, declined, expired or cancelled (QUO-11); shown as an
      // event, never as a note to edit, even though "sent" is stored as the sender's note so it counts as contact with the customer
      text = quoteEntryText(
        quoteKind,
        metaString(activity.metadata, "number"),
        quoteTitles.get(metaString(activity.metadata, "quote_id") ?? "") ?? null,
        quoteEntryBy(quoteKind, body),
      );
      isUserContent = false;
    } else if (activity.type === "status_change") {
      const from = statusNames.get(metaString(activity.metadata, "from_status_id") ?? "");
      const to = statusNames.get(metaString(activity.metadata, "to_status_id") ?? "");
      text = from && to ? `הסטטוס שונה מ"${from}" ל"${to}".` : "הסטטוס שונה.";
      isUserContent = false;
    } else if (activity.type === "stage_change") {
      const from = stageNames.get(metaString(activity.metadata, "from_stage_id") ?? "");
      const to = stageNames.get(metaString(activity.metadata, "to_stage_id") ?? "");
      text = stageChangeText(from, to, terms);
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
    } else if (activity.type === "system" && metaString(activity.metadata, "kind") === "snooze_cleared") {
      // written by the database when a move to another stage cancels a postponement
      isUserContent = false;
    } else if (isResponsePass(activity)) {
      // SPD-03: written by the database when a lead nobody answered in time went to the next rep; drawn from its metadata
      // in the business's words (the stored text stays when the metadata is not complete)
      text =
        responsePassText(
          {
            fromUserId: metaString(activity.metadata, "from_user_id"),
            toUserId: metaString(activity.metadata, "to_user_id"),
            targetMinutes: metaNumber(activity.metadata, "target_minutes"),
          },
          authors,
          terms,
        ) ?? text;
      isUserContent = false;
    } else if (activity.type === "conversion") {
      text = conversionText(terms);
      isUserContent = false;
    }

    // TASK-08: a logged entry is named by the business's type (its own, else the default of its kind)
    const logged = !quoteKind && isActivityBase(activity.type) ? entryLabel(activity.activity_type_id, activity.type, types) : null;
    return {
      id: activity.id,
      // a quote entry is an event on screen: no edit, delete or pin buttons
      type: quoteKind ? "system" : activity.type,
      // WA-01: a message opened from the record's WhatsApp button
      label: moneyKind
        ? moneyEntryLabel(moneyKind)
        : quoteKind
          ? "הצעת מחיר"
          : activity.type === "whatsapp" && metaString(activity.metadata, "via") === "link"
            ? "נשלחה הודעת WhatsApp"
            : logged
              ? logged.name
              : (TYPE_LABELS[activity.type] ?? "פעילות"),
      // TASK-08: the icon of the business's type (logged kinds only)
      icon: logged?.icon ?? null,
      text,
      isUserContent,
      body: activity.body ?? "",
      occurredAt: activity.occurred_at,
      // AUT-02: an automation's note names the rule (as it was called then), not the person who ran it
      authorName:
        activity.type === "automation_note"
          ? metaString(activity.metadata, "automation_name")
          : activity.created_by
            ? (authors.get(activity.created_by) ?? null)
            : null,
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
