import type { Json } from "@/lib/database.types";

// The JSON staff type for plan limits / features and per-organization overrides
// (/admin/plans, /admin/orgs/[orgId]). Only values app.org_limit / app.org_has_feature
// (and their TS mirror in src/lib/plan-keys.ts) read the same way are accepted:
// a feature is true or false; a limit is a non-negative number or null (unlimited).

export type PlanJsonKind = "limits" | "features";
export type PlanJsonResult = { ok: true; value: Json } | { ok: false; message: string };

const NOT_OBJECT: Record<PlanJsonKind, string> = {
  limits: 'המגבלות צריכות להיות JSON של אובייקט, למשל {"max_users": 50}.',
  features: 'היכולות צריכות להיות JSON של אובייקט, למשל {"quotes": true}.',
};

/** Parses and checks one JSON object of limits or features; an empty field is {}. */
export function parsePlanJson(raw: string, kind: PlanJsonKind): PlanJsonResult {
  if (raw.trim() === "") return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, message: NOT_OBJECT[kind] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: NOT_OBJECT[kind] };
  }
  for (const [key, item] of Object.entries(value)) {
    if (kind === "features" && typeof item !== "boolean") {
      return { ok: false, message: `ערך דגל חייב להיות true או false (${key}).` };
    }
    if (kind === "limits" && item !== null && !(typeof item === "number" && Number.isFinite(item) && item >= 0)) {
      return { ok: false, message: `ערך מגבלה חייב להיות מספר (0 ומעלה) או null (${key}).` };
    }
  }
  return { ok: true, value: value as Json };
}
