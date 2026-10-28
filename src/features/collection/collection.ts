import { z } from "zod";

import { AGING_BUCKETS, type AgingKey } from "@/features/balances/debt";
import type { OrgTerms } from "@/features/terminology/terms";

// COL-01: what public.collection_documents answers and how the collection screen reads its filters. The database holds every
// rule (which documents owe, the age buckets, the customer and the rep); this file only parses and labels. Pure, unit tested.

const money = z.coerce.number().int().nonnegative();
const count = z.coerce.number().int().nonnegative();

export const COLLECTION_BUCKETS = AGING_BUCKETS.map(
  (b) => b.key,
) as readonly AgingKey[];
const bucket = z.enum(["current", "d1_30", "d31_60", "d61_90", "d91_plus"]);
const customerKind = z.enum(["company", "contact", "deal"]);
export type CollectionCustomerKind = z.infer<typeof customerKind>;

const row = z.object({
  id: z.string(),
  doc_type: z.enum(["tax_invoice", "proforma", "opening_balance"]),
  number: z.string().nullable(),
  doc_date: z.string(),
  due_date: z.string().nullable(),
  amount: money,
  balance: money,
  days_late: z.number().int().nullable(),
  bucket,
  deal_id: z.string().nullable(),
  contact_id: z.string().nullable(),
  company_id: z.string().nullable(),
  customer_kind: customerKind,
  customer_id: z.string(),
  customer_name: z.string().nullable(),
  owner_id: z.string().nullable(),
  held: z.boolean(),
});
export type CollectionRow = z.infer<typeof row>;

const totals = z.object({
  total: money,
  overdue: money,
  documents: count,
  overdue_documents: count,
  current: money,
  d1_30: money,
  d31_60: money,
  d61_90: money,
  d91_plus: money,
});

const listed = {
  today: z.string(),
  more: z.boolean(),
  documents: z.array(row),
};
const answer = z.union([
  z.object({ allowed: z.literal(false) }),
  // owner's answer (3) ב: a user who does not read every document and payment sees the documents they read, with their
  // amounts, and no total of any kind
  z.object({
    allowed: z.literal(true),
    partial: z.literal(true),
    totals: z.null(),
    shown: z.null(),
    ...listed,
  }),
  z.object({
    allowed: z.literal(true),
    partial: z.literal(false),
    totals,
    shown: z.object({ total: money, documents: count }),
    ...listed,
  }),
]);
export type Collection = z.infer<typeof answer>;
export type ListedCollection = Exclude<Collection, { allowed: false }>;
export type FullCollection = Extract<Collection, { partial: false }>;

/** The answer of public.collection_documents; a shape it does not know throws (FXC-12). */
export function parseCollection(raw: unknown): Collection {
  return answer.parse(raw);
}

/** The screen's filters, from the address. Anything unknown is dropped, never guessed. */
export type CollectionFilters = {
  owner: string | null;
  overdue: boolean;
  bucket: AgingKey | null;
  customer: { kind: CollectionCustomerKind; id: string } | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function collectionFilters(
  query: Record<string, string | string[] | undefined>,
): CollectionFilters {
  const first = (key: string) => {
    const value = query[key];
    return (Array.isArray(value) ? value[0] : value) ?? "";
  };
  const owner = first("owner");
  const b = first("bucket");
  const kind = first("ck");
  const id = first("cid");
  const parsedKind = customerKind.safeParse(kind);
  return {
    owner: UUID.test(owner) ? owner.toLowerCase() : null,
    overdue: first("overdue") === "1",
    bucket: (COLLECTION_BUCKETS as readonly string[]).includes(b)
      ? (b as AgingKey)
      : null,
    customer:
      parsedKind.success && UUID.test(id)
        ? { kind: parsedKind.data, id: id.toLowerCase() }
        : null,
  };
}

/** The address of the screen with these filters (empty ones left out). */
export function collectionHref(
  base: string,
  filters: CollectionFilters,
): string {
  const params = new URLSearchParams();
  if (filters.owner) params.set("owner", filters.owner);
  if (filters.overdue) params.set("overdue", "1");
  if (filters.bucket) params.set("bucket", filters.bucket);
  if (filters.customer) {
    params.set("ck", filters.customer.kind);
    params.set("cid", filters.customer.id);
  }
  const text = params.toString();
  return text ? `${base}?${text}` : base;
}

/** "באיחור של 12 ימים" / "לתשלום עד היום" / "בלי מועד תשלום"; whole days in the business's zone (BAL-03). */
export function lateText(daysLate: number | null): string {
  if (daysLate === null) return "בלי מועד תשלום";
  if (daysLate === 1) return "באיחור של יום אחד";
  if (daysLate > 1) return `באיחור של ${daysLate} ימים`;
  if (daysLate === 0) return "לתשלום היום";
  if (daysLate === -1) return "לתשלום מחר";
  return `לתשלום בעוד ${-daysLate} ימים`;
}

/** The bucket's words (BAL-03's labels). */
export function bucketLabel(key: AgingKey): string {
  return AGING_BUCKETS.find((b) => b.key === key)?.label ?? key;
}

/** FLD-10: the words that name a customer's kind and the screen's description, in the business's own words. */
export function collectionTexts(terms: OrgTerms): {
  description: string;
  kind: Record<CollectionCustomerKind, string>;
} {
  return {
    description: `מסמכים פתוחים עם יתרה לתשלום: חשבוניות מס, חשבונות עסקה ויתרות פתיחה, לפי ימי האיחור. הלקוח הוא החברה, ואם אין חברה ${terms.contact.theSingular} או ${terms.deal.theSingular}.`,
    kind: {
      company: "חברה",
      contact: terms.contact.singular,
      deal: terms.deal.singular,
    },
  };
}
