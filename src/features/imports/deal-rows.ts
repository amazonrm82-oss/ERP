// IMP-03: one row of a deals file -> the columns of public.deals and the names and keys the server
// resolves (pipeline, stage, owner, contact, company, source, tags), or the reason it cannot be
// imported. Pure (no database). Used by the import (deal-server.ts) and its unit tests.

import { agorotInput, BILLING_KIND_LABELS, BILLING_KINDS, recurringSchema, type RecurringPatch } from "@/features/deals/recurring";
import { closedAtFor } from "@/features/deals/close-window";
import type { StageKind } from "@/lib/database.types";

import { choiceOf, companyKey, nameKey, parseDateCell, parseMoneyCell, personKey, splitTags, TAG_NAME_MAX, type PersonKey } from "./record-cells";

export const DEAL_NAME_MAX = 200;

export type ParsedDealRow = {
  values: {
    name: string;
    // null = empty: the database sets the first-year value of a recurring deal, else 0 (DEAL-07)
    amount_agorot: number | null;
    expected_close_date: string | null;
  } & RecurringPatch;
  pipeline: string | null;
  stage: string | null;
  // the day the deal really closed (only kept on a won or lost stage)
  closedDate: string | null;
  owner: string | null;
  contact: PersonKey | null;
  company: { name: string; domain: string | null } | null;
  source: string | null;
  tags: string[];
};

const BILLING_OPTIONS = BILLING_KINDS.map((value) => ({ value, label: BILLING_KIND_LABELS[value] }));
const BILLING_SYNONYMS: Record<string, (typeof BILLING_KINDS)[number]> = {
  "חד פעמי": "one_time",
  "חד פעמית": "one_time",
  חדפעמית: "one_time",
  "one time": "one_time",
  once: "one_time",
  חודשי: "monthly",
  חודש: "monthly",
  month: "monthly",
  monthly: "monthly",
  שנתי: "yearly",
  שנה: "yearly",
  year: "yearly",
  annual: "yearly",
  yearly: "yearly",
};

const RECURRING_KEYS = ["recurring_amount", "recurring_start_date", "renewal_date"] as const;

export const CLOSED_DATE_FUTURE = "תאריך הסגירה בפועל לא יכול להיות בעתיד.";
export const RECURRING_WITHOUT_KIND = "יש סכום חוזר או תאריכי עסקה חוזרת, אבל חסר סוג עסקה (חודשית או שנתית).";
export const RECURRING_ON_ONE_TIME = "העסקה חד-פעמית, ולכן הסכום החוזר והתאריכים שלו לא נשמרו.";

/** A date cell, or the message when it is not a date. */
function dateOf(raw: string | undefined, label: string): { ok: true; value: string | null } | { ok: false; message: string } {
  if (!raw) return { ok: true, value: null };
  const value = parseDateCell(raw);
  return value ? { ok: true, value } : { ok: false, message: `${label} "${raw}" אינו תאריך תקין (למשל 31/12/2026).` };
}

/**
 * Checks one row. `raw` holds the non-empty cells by target key; `today` is the organization's
 * calendar day. A warning means the row is imported but something in it is not kept.
 */
export function parseDealRow(raw: Record<string, string>, today: string): { row: ParsedDealRow; warning: string | null } | string {
  const name = raw.name?.trim().replace(/\s+/g, " ") ?? "";
  if (!name) return "חסר שם לעסקה.";
  if (Array.from(name).length > DEAL_NAME_MAX) return `שם העסקה ארוך מדי (עד ${DEAL_NAME_MAX} תווים).`;

  let amount: number | null = null;
  if (raw.amount) {
    amount = parseMoneyCell(raw.amount);
    if (amount === null) return `הערך "${raw.amount}" אינו סכום תקין (למשל 12,500).`;
  }

  const expected = dateOf(raw.expected_close_date, "תאריך הסגירה הצפוי");
  if (!expected.ok) return expected.message;
  const closed = dateOf(raw.closed_date, "תאריך הסגירה בפועל");
  if (!closed.ok) return closed.message;
  if (closed.value && closed.value > today) return CLOSED_DATE_FUTURE;

  // DEAL-07: the same rules as the deal form (recurringSchema); dates are read day first first
  let warning: string | null = null;
  let recurring: RecurringPatch = { billing_kind: null, recurring_amount_agorot: null, recurring_start_date: null, renewal_date: null };
  const hasRecurring = RECURRING_KEYS.some((k) => Boolean(raw[k]));
  const kind = raw.billing_kind ? choiceOf(raw.billing_kind, BILLING_OPTIONS, BILLING_SYNONYMS) : null;
  if (raw.billing_kind && !kind) return `סוג העסקה "${raw.billing_kind}" לא מוכר. אפשר: חד-פעמית, חודשית או שנתית.`;
  if (!kind && hasRecurring) return RECURRING_WITHOUT_KIND;
  if (kind === "one_time" && hasRecurring) warning = RECURRING_ON_ONE_TIME;
  if (kind && kind !== "one_time") {
    const start = dateOf(raw.recurring_start_date, "תאריך ההתחלה");
    if (!start.ok) return start.message;
    const renewal = dateOf(raw.renewal_date, "תאריך החידוש");
    if (!renewal.ok) return renewal.message;
    let recurringAmount = "";
    if (raw.recurring_amount) {
      const agorot = parseMoneyCell(raw.recurring_amount);
      if (agorot === null) return `הסכום החוזר "${raw.recurring_amount}" אינו סכום תקין (למשל 1,200).`;
      recurringAmount = agorotInput(agorot);
    }
    const parsed = recurringSchema.safeParse({
      billing_kind: kind,
      recurring_amount: recurringAmount,
      recurring_start_date: start.value ?? "",
      renewal_date: renewal.value ?? "",
    });
    if (!parsed.success) return parsed.error.issues[0]?.message ?? "פרטי העסקה החוזרת אינם תקינים.";
    recurring = parsed.data;
  }

  const contact = raw.contact ? personKey(raw.contact) : null;
  if (raw.contact && !contact) return `באיש הקשר צריך להיות אימייל או טלפון, ולא "${raw.contact}".`;

  const tags = raw.tags ? splitTags(raw.tags) : [];
  const longTag = tags.find((t) => Array.from(t).length > TAG_NAME_MAX);
  if (longTag) return `שם התגית "${longTag}" ארוך מדי (עד ${TAG_NAME_MAX} תווים).`;

  return {
    row: {
      values: { name, amount_agorot: amount, expected_close_date: expected.value, ...recurring },
      pipeline: raw.pipeline?.trim() || null,
      stage: raw.stage?.trim() || null,
      closedDate: closed.value,
      owner: raw.owner?.trim() || null,
      contact,
      company: raw.company ? companyKey(raw.company) : null,
      source: raw.source?.trim() || null,
      tags,
    },
    warning,
  };
}

export type PipelineRef = { id: string; name: string; isDefault: boolean; position: number };
export type StageRef = { id: string; pipelineId: string; name: string; kind: StageKind; position: number };

/**
 * The pipeline and stage a row names. No pipeline: the default one (else the first). No stage:
 * the pipeline's first open stage. A name that is not there is an error, never a new stage.
 */
export function resolveStage(
  pipelines: PipelineRef[],
  stages: StageRef[],
  pipelineName: string | null,
  stageName: string | null,
): { pipelineId: string; stageId: string; kind: StageKind } | string {
  const ordered = [...pipelines].sort((a, b) => a.position - b.position);
  const pipeline = pipelineName
    ? ordered.find((p) => nameKey(p.name) === nameKey(pipelineName))
    : (ordered.find((p) => p.isDefault) ?? ordered[0]);
  if (!pipeline) return pipelineName ? `אין פייפליין בשם "${pipelineName}".` : "אין פייפליין בעסק.";
  const own = stages.filter((s) => s.pipelineId === pipeline.id).sort((a, b) => a.position - b.position);
  const stage = stageName ? own.find((s) => nameKey(s.name) === nameKey(stageName)) : (own.find((s) => s.kind === "open") ?? own[0]);
  if (!stage) {
    return stageName ? `אין שלב בשם "${stageName}" בפייפליין "${pipeline.name}". שלב חדש לא נוצר בייבוא.` : `בפייפליין "${pipeline.name}" אין שלבים.`;
  }
  return { pipelineId: pipeline.id, stageId: stage.id, kind: stage.kind };
}

export const CLOSED_DATE_ON_OPEN = "העסקה בשלב פתוח, ולכן תאריך הסגירה בפועל לא נשמר.";

/**
 * DEAL-04: the close date of a won or lost deal. The file's close date; without one the expected
 * close date when it is not after today; without both the database stamps the time of the import.
 * Stored like the close window does (closedAtFor): now for today, else 12:00 in the business's zone.
 * An open deal keeps none (the database clears it).
 */
export function closedAtForRow(
  kind: StageKind,
  closedDate: string | null,
  expectedCloseDate: string | null,
  today: string,
  now: Date,
  timeZone: string,
): { closedAt: string | null; warning: string | null } {
  if (kind === "open") return { closedAt: null, warning: closedDate ? CLOSED_DATE_ON_OPEN : null };
  const day = closedDate ?? (expectedCloseDate && expectedCloseDate <= today ? expectedCloseDate : null);
  return { closedAt: day ? closedAtFor(day, today, now, timeZone) : null, warning: null };
}
