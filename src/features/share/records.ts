// WAB-06: the records a share may be saved to, from the global search's answer. Pure, so it is unit-tested.

import type { SearchPickerHit } from "@/components/ui/search-picker-logic";
import { SUBJECT_KINDS, type SubjectKind, type TimelineSubject } from "@/features/activities/schema";
import type { OrgModules } from "@/features/modules/modules";
import type { OrgTerms } from "@/features/terminology/terms";

type Row = Record<string, unknown>;
export type SearchRecordsAnswer = Partial<Record<"leads" | "contacts" | "companies" | "deals", Row[] | null>> | null;

const GROUPS: { key: "leads" | "contacts" | "companies" | "deals"; kind: SubjectKind }[] = [
  { key: "contacts", kind: "contact" },
  { key: "leads", kind: "lead" },
  { key: "deals", kind: "deal" },
  { key: "companies", kind: "company" },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The kind's word in this business (FLD-10). */
export function kindLabel(kind: SubjectKind, terms: OrgTerms): string {
  switch (kind) {
    case "lead":
      return terms.lead.singular;
    case "contact":
      return terms.contact.singular;
    case "deal":
      return terms.deal.singular;
    default:
      return "חברה";
  }
}

export function shareSearchHits(answer: SearchRecordsAnswer, modules: Pick<OrgModules, "leads" | "companies">, terms: OrgTerms): SearchPickerHit[] {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return [];
  const hits: SearchPickerHit[] = [];
  for (const { key, kind } of GROUPS) {
    // LEAD-08: a switched-off module's records are not offered
    if ((kind === "lead" && !modules.leads) || (kind === "company" && !modules.companies)) continue;
    const rows = answer[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const id = typeof row.id === "string" && UUID.test(row.id) ? row.id.toLowerCase() : null;
      if (!id) continue;
      const label = kindLabel(kind, terms);
      const subtitle = kind === "deal" ? null : str(row.subtitle);
      hits.push({ id: `${kind}:${id}`, label: str(row.title) ?? `${label} ללא שם`, detail: subtitle ? `${label} · ${subtitle}` : label });
    }
  }
  return hits;
}

/** A picked hit's id back to the record; anything else is null. */
export function subjectFromPick(value: unknown): TimelineSubject | null {
  if (typeof value !== "string") return null;
  const [kind, id, ...rest] = value.split(":");
  if (rest.length > 0 || !(SUBJECT_KINDS as readonly string[]).includes(kind) || !UUID.test(id ?? "")) return null;
  return { kind: kind as SubjectKind, id: id.toLowerCase() };
}
