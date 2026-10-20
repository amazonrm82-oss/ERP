import type { Json } from "@/lib/database.types";

import type { Entity } from "./definitions";

// AUT-02: the steps that create a deal ("create_deal") or a note ("create_note"). The engine
// (app.run_automation_actions, migration 020160) checks every id again when the rule runs; these helpers only
// turn the builder's values into the stored rule and back, and say a rule in Hebrew.

/** The record types a "create deal" step fits: a lead becomes a deal by conversion, not by an automation. */
export const CREATE_DEAL_ENTITIES: readonly Entity[] = ["contact", "company", "deal", "task"];

// the engine refuses more than a billion shekels
export const DEAL_AMOUNT_MAX_AGOROT = 100_000_000_000;
export const DEAL_NAME_MAX = 200;
export const NOTE_BODY_MAX = 2000;
/** Today's word for a deal: an empty name made by the database is "עסקה: <name>" (app.run_automation_actions). */
export const DEFAULT_DEAL_WORD = "עסקה";

/** FLD-10 part three: the default name of a deal a rule makes, in the business's word. */
export function defaultDealName(dealWord: string = DEFAULT_DEAL_WORD): string {
  return `${dealWord}: {{name}}`;
}

export const DEFAULT_DEAL_NAME = defaultDealName();

type PipelineLookup = { id: string; name: string; stages: Array<{ id: string; name: string; kind?: string }> };

/** The open stages of a pipeline, in the pipeline's order (a step may start a deal only in an open stage). */
export function openStagesOf(pipelines: PipelineLookup[], pipelineId: string): Array<{ id: string; name: string }> {
  const pipeline = pipelines.find((p) => p.id === pipelineId);
  return (pipeline?.stages ?? []).filter((stage) => stage.kind === "open").map((stage) => ({ id: stage.id, name: stage.name }));
}

/** Shekels as typed ("2,500", "₪ 99.90") -> agorot, or null when it is not a valid amount. Empty = 0. */
export function shekelsToAgorot(raw: string): number | null {
  const text = raw.replace(/[,\s₪]/g, "");
  if (text === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const agorot = Math.round(Number(text) * 100);
  return Number.isSafeInteger(agorot) && agorot <= DEAL_AMOUNT_MAX_AGOROT ? agorot : null;
}

export type CreateDealInput = {
  name?: string;
  pipeline_id: string;
  stage_id?: string;
  amount?: string;
  assign: "owner" | "user";
  user_id?: string;
  // DEAL-08 follow-up (deal rules only): "1" = in the triggering deal's sales process; "1" = copy its recurring revenue and lines
  pipeline_source?: string;
  copy_source?: string;
};

/** The builder's "create deal" values -> the stored action, or a Hebrew message. */
export function createDealAction(
  entity: Entity,
  input: CreateDealInput,
  lookups: { pipelines: PipelineLookup[]; members: Array<{ id: string }>; dealWord?: string },
): Record<string, Json> | string {
  if (!CREATE_DEAL_ENTITIES.includes(entity)) return "ליד הופך לעסקה בהמרה. יצירת עסקה מתאימה לאנשי קשר, חברות, עסקאות ומשימות.";
  if (!lookups.pipelines.some((p) => p.id === input.pipeline_id)) return "תהליך המכירה שנבחר כבר לא קיים.";
  if (input.stage_id && !openStagesOf(lookups.pipelines, input.pipeline_id).some((s) => s.id === input.stage_id)) {
    return "השלב שנבחר אינו שלב פתוח בתהליך המכירה.";
  }
  if (input.assign === "user" && !lookups.members.some((m) => m.id === input.user_id)) return "המשתמש שנבחר כבר לא פעיל.";
  const amount = shekelsToAgorot(input.amount ?? "");
  if (amount === null) return "יש להזין סכום תקין לעסקה (עד מיליארד ₪).";
  const fromSource = input.pipeline_source === "1";
  const copySource = input.copy_source === "1";
  if ((fromSource || copySource) && entity !== "deal") return "העתקה מהעסקה המקורית מתאימה רק לאוטומציה על עסקאות.";
  const out: Record<string, Json> = { type: "create_deal", pipeline_id: input.pipeline_id, assign: input.assign };
  // the engine falls back to pipeline_id when the source deal's process is gone, so it is kept
  if (fromSource) out.pipeline = "source";
  if (copySource) out.copy_from_source = true;
  const name = input.name?.trim();
  if (name) out.name = name;
  // an empty name: the database's default is today's word, so a business with its own word stores its default here
  else if (lookups.dealWord && lookups.dealWord !== DEFAULT_DEAL_WORD) out.name = defaultDealName(lookups.dealWord);
  if (input.stage_id) out.stage_id = input.stage_id;
  if (amount > 0) out.amount_agorot = amount;
  if (input.assign === "user" && input.user_id) out.user_id = input.user_id;
  return out;
}

const str = (value: unknown) => (value === undefined || value === null ? "" : String(value));

/** A stored "create deal" action -> the builder's values. */
export function createDealDraft(action: Record<string, unknown>): Record<string, string> {
  return {
    type: "create_deal",
    name: str(action.name),
    pipeline_id: str(action.pipeline_id),
    stage_id: str(action.stage_id),
    amount: typeof action.amount_agorot === "number" && action.amount_agorot > 0 ? String(action.amount_agorot / 100) : "",
    assign: action.assign === "user" ? "user" : "owner",
    user_id: str(action.user_id),
    pipeline_source: action.pipeline === "source" ? "1" : "",
    copy_source: action.copy_from_source === true ? "1" : "",
  };
}

const nameIn = (list: Array<{ id: string; name: string }>, id: unknown) => list.find((item) => item.id === id)?.name ?? "(נמחק)";

/** `"<name>" בתהליך X, בשלב Y, ₪ Z, לאחראי` for a rule's description. */
export function describeCreateDeal(
  action: Record<string, unknown>,
  lookups: { pipelines: PipelineLookup[]; members: Array<{ id: string; name: string }>; dealWord?: string },
): string {
  // a stored rule without a name makes the database's "עסקה: <name>"
  const parts = [`"${str(action.name) || DEFAULT_DEAL_NAME}"`];
  const stages = lookups.pipelines.find((p) => p.id === action.pipeline_id)?.stages ?? [];
  const fallback = `${nameIn(lookups.pipelines, action.pipeline_id)}${action.stage_id ? `, שלב ${nameIn(stages, action.stage_id)}` : ""}`;
  if (action.pipeline === "source") {
    parts.push(`בתהליך המכירה של העסקה המקורית, בשלב הפתוח הראשון (אם אינו קיים: ${fallback})`);
  } else {
    parts.push(`בתהליך ${nameIn(lookups.pipelines, action.pipeline_id)}`);
    parts.push(action.stage_id ? `בשלב ${nameIn(stages, action.stage_id)}` : "בשלב הפתוח הראשון");
  }
  if (action.copy_from_source === true) parts.push("עם ההכנסה החוזרת והשורות של העסקה המקורית");
  if (typeof action.amount_agorot === "number" && action.amount_agorot > 0) {
    parts.push(`₪${(action.amount_agorot / 100).toLocaleString("he-IL")}`);
  }
  parts.push(action.assign === "user" ? `ל${nameIn(lookups.members, action.user_id)}` : "לאחראי");
  return parts.join(", ");
}
