import { channelTypeLabel } from "@/features/contacts/channels";
import type { Json } from "@/lib/database.types";
import { formatDateTime } from "@/lib/format";
import { isUuid } from "@/lib/paths";

import { ACTION_LABELS, ENTITY_LABELS, FIELD_LABELS, HIDDEN_FIELDS, VALUE_LABELS } from "../labels";
import type { AuditItem } from "../queries";

function show(value: Json, field: string, names: Map<string, string>): string {
  if (value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "כן" : "לא";
  if ((field === "amount_agorot" || field === "budget_agorot" || field === "recurring_amount_agorot") && typeof value === "number") return `₪${(value / 100).toLocaleString("he-IL")}`;
  // CON-01: the type of a contact's primary phone or email
  if ((field === "phone_type" || field === "email_type") && typeof value === "string") {
    return channelTypeLabel(field === "phone_type" ? "phone" : "email", value) ?? value;
  }
  // GOL-01: coded values (a goal's metric, scope and period) in Hebrew; an unknown code stays as it is
  if (typeof value === "string" && VALUE_LABELS[field]?.[value]) return VALUE_LABELS[field][value];
  if (typeof value === "string") {
    const text: string = value;
    // isUuid() is a type guard ("is string"); a plain boolean keeps the string type afterwards
    const looksLikeId: boolean = isUuid(text);
    if (looksLikeId) return names.get(text) ?? "ערך אחר";
    if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return formatDateTime(text);
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  }
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

type Props = { items: AuditItem[]; names: Map<string, string>; showEntity?: boolean };

/** Audit entries: who, when, what, and field by field old -> new. */
export function AuditEntries({ items, names, showEntity = true }: Props) {
  return (
    <ul className="divide-y divide-line">
      {items.map((item) => {
        const changes = item.changes.filter((c) => !HIDDEN_FIELDS.has(c.field));
        return (
          <li key={item.id} className="px-4 py-3 sm:px-5">
            <p className="text-md">
              <span className="font-medium">{ACTION_LABELS[item.action] ?? item.action}</span>
              {showEntity ? <span className="text-ink-soft"> · {ENTITY_LABELS[item.entityType] ?? item.entityType}</span> : null}
            </p>
            <p className="text-sm text-ink-soft">
              {formatDateTime(item.createdAt)} · {item.actorName ?? "המערכת"}
            </p>
            {item.erased ? <p className="mt-1.5 text-sm text-ink-soft">הפרטים נמחקו לבקשת פרטיות.</p> : null}
            {item.note ? <p className="mt-1.5 break-words text-sm">{item.note}</p> : null}
            {changes.length > 0 ? (
              <ul className="mt-1.5 space-y-0.5 text-sm">
                {changes.map((c) => (
                  <li key={c.field} className="break-words">
                    <span className="text-ink-soft">{FIELD_LABELS[c.field] ?? c.field}: </span>
                    <span dir="auto">{show(c.old, c.field, names)}</span>
                    <span aria-label="שונה ל"> ← </span>
                    <span dir="auto">{show(c.new, c.field, names)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Ids found in the changes (owners, statuses, stages...), for the caller to name. */
export function idsInChanges(items: AuditItem[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    for (const c of item.changes) {
      for (const v of [c.old, c.new]) if (typeof v === "string" && isUuid(v)) ids.add(v);
    }
  }
  return [...ids];
}
