// CON-06: relations between contacts. The types are a managed list per business (public.contact_relation_types, at
// most 20). A type reads from the first contact: "A <name> B" (הורה של), and from the second: "B <reverse_name> A"
// (ילד/ה של); no reverse name = the same both ways (בן/בת זוג של). These four are the defaults the database seeds
// (app.seed_contact_relation_types, a unit test keeps the two equal). The referrals report counts the type whose key is
// 'referral', under whatever name the business gives it; a lead takes part only as the referrer of that type.

export const DEFAULT_CONTACT_RELATION_TYPES = [
  { key: "spouse", name: "בן/בת זוג של", reverseName: null },
  { key: "family", name: "בן/בת משפחה של", reverseName: null },
  { key: "parent", name: "הורה של", reverseName: "ילד/ה של" },
  { key: "referral", name: "הפנה/תה את", reverseName: "הופנה/תה על ידי" },
] as const;

// the type a lead may take part in, as the referrer (trigger contact_relations_check, hint 'contact_relation:lead_type')
export const REFERRAL_TYPE_KEY = "referral";

// the database refuses more (trigger contact_relation_types_cap, hint 'contact_relation_types:max')
export const CONTACT_RELATION_TYPES_PER_ORG = 20;
// the check constraints of name and reverse_name
export const CONTACT_RELATION_NAME_MAX = 40;
// per contact from the browser (trigger contact_relations_check, hint 'contact_relation:max')
export const CONTACT_RELATIONS_PER_CONTACT = 50;

/** A type of the business's list. */
export type ContactRelationType = { id: string; name: string; reverseName: string | null; key: string | null; isActive: boolean };

/** Which side of a relation a contact is on: the first ("A <name> B") or the second ("B <reverse> A"). */
export type RelationSide = "out" | "in";

/** The phrase that describes a contact's side of a relation: its own relation to the other one. */
export function relationPhrase(type: Pick<ContactRelationType, "name" | "reverseName">, side: RelationSide): string {
  return side === "out" ? type.name : (type.reverseName ?? type.name);
}

/**
 * The choices offered when a relation is added on a contact's card: each active type in its own direction, and a
 * type with a reverse name also the other way ("ילד/ה של"). The value carries the type and the side of this contact.
 */
export function relationChoices(types: ContactRelationType[]): Array<{ value: string; label: string }> {
  return types
    .filter((type) => type.isActive)
    .flatMap((type) => [
      { value: `${type.id}:out`, label: type.name },
      ...(type.reverseName ? [{ value: `${type.id}:in`, label: type.reverseName }] : []),
    ]);
}

/** A choice value back into its type and side; null for anything else. */
export function parseRelationChoice(value: unknown): { typeId: string; side: RelationSide } | null {
  if (typeof value !== "string") return null;
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(out|in)$/i.exec(value);
  return match ? { typeId: match[1].toLowerCase(), side: match[2] as RelationSide } : null;
}
