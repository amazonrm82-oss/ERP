// DQL-03: periodic cleanup suggestions (public.cleanup_suggestions, invoker: RLS decides what is counted).
// The shape of the answer, checked before the page reads it, and the screen's small texts.

import { z } from "zod";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const count = z.number().int().nonnegative();

export const CLEANUP_MATCHES = ["phone", "email", "tax_id", "name"] as const;
export type CleanupMatch = (typeof CLEANUP_MATCHES)[number];

const cleanupAnswer = z.object({
  allowed: z.literal(true),
  since: z.string(),
  duplicates: z.object({
    count,
    items: z.array(
      z.object({
        type: z.enum(["lead", "contact", "company"]),
        id: uuid,
        name: z.string().nullable(),
        created_at: z.string(),
        other_id: uuid,
        other_name: z.string().nullable(),
        match: z.enum(CLEANUP_MATCHES),
      }),
    ),
  }),
  unowned_leads: z.object({
    count,
    items: z.array(z.object({ id: uuid, name: z.string().nullable(), created_at: z.string() })),
  }),
  no_channel: z.object({
    count,
    leads: count,
    contacts: count,
    items: z.array(z.object({ type: z.enum(["lead", "contact"]), id: uuid, name: z.string().nullable(), created_at: z.string() })),
  }),
  rare_options: z.object({
    count,
    min_filled: count,
    max_used: count,
    items: z.array(
      z.object({
        object_type: z.enum(["lead", "contact", "company", "deal"]),
        field_key: z.string(),
        field_label: z.string(),
        option: z.string(),
        used: count,
        filled: count,
      }),
    ),
  }),
});

// review 7: the database answers {allowed: false} to anyone but owners, admins and managers
export const cleanupSchema = z.union([z.object({ allowed: z.literal(false) }), cleanupAnswer]);

export type CleanupAnswer = z.infer<typeof cleanupSchema>;
export type CleanupSuggestions = z.infer<typeof cleanupAnswer>;

/** How many items each group lists on the screen (the counts are always the whole group). */
export const CLEANUP_LIST_LIMIT = 20;

const MATCH_TEXT: Record<CleanupMatch, string> = {
  phone: "אותו טלפון",
  email: "אותו אימייל",
  tax_id: "אותו ח.פ.",
  name: "אותו שם",
};

export function cleanupMatchText(match: CleanupMatch): string {
  return MATCH_TEXT[match];
}

/** "בשימוש ברשומה אחת מתוך 120" / "לא בשימוש באף רשומה מתוך 120" */
export function rareOptionText(used: number, filled: number): string {
  const total = filled.toLocaleString("he-IL");
  if (used === 0) return `לא בשימוש באף רשומה מתוך ${total} שבהן השדה מלא`;
  if (used === 1) return `בשימוש ברשומה אחת מתוך ${total} שבהן השדה מלא`;
  return `בשימוש ב-${used.toLocaleString("he-IL")} רשומות מתוך ${total} שבהן השדה מלא`;
}

// Review (e557d28, medium): a large business can pass the hosted statement timeout (8 s for `authenticated`, SQLSTATE 57014);
// the page then says so in Hebrew instead of the error page. Any other database or shape error gets the general line.
export const CLEANUP_TIMEOUT_MESSAGE = "ההצעות לא נטענו: יש יותר מדי רשומות לבדיקה כרגע. ההתראה השבועית ממשיכה לספור.";
export const CLEANUP_FAILED_MESSAGE = "ההצעות לא נטענו כרגע. נסו שוב בעוד כמה דקות. ההתראה השבועית ממשיכה לספור.";

/** The Hebrew line for a failed read of the suggestions (a statement timeout, or anything else). */
export function cleanupLoadMessage(error: { code?: string | null } | null | undefined): string {
  return error?.code === "57014" ? CLEANUP_TIMEOUT_MESSAGE : CLEANUP_FAILED_MESSAGE;
}

/** Who opens the cleanup page: the people who manage others (owners, admins, managers). */
export function canSeeCleanup(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin" || role === "manager";
}
