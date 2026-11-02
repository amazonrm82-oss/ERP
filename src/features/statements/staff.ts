import { z } from "zod";

import { publicStatementFrom, type PublicStatement } from "./public";

// BAL-04 (owner, 2 November 2026, answers (35) א and (36) ב): the staff's statement, from public.statement_staff_view(org,
// contact, company) (security invoker, the user's session): public.statement_public's answer for one customer under BAL-01's
// rights, keys and partial rule, plus `bank_elsewhere` (true only for a reader who is not an owner or admin while the
// statement's switch is on: the customer's page shows the details, this reader may not; switch off = no details, no line). Pure, so it is unit tested.

export type StaffStatement =
  | { state: "not-allowed" }
  | { state: "partial" }
  | { state: "not-found" }
  | { state: "company" }
  | { state: "ok"; statement: PublicStatement; bankElsewhere: boolean };

const headSchema = z.object({
  allowed: z.boolean(),
  partial: z.boolean().optional(),
  refused: z.enum(["not_found", "company"]).optional(),
  bank_elsewhere: z.boolean().optional(),
});

/** The view's answer as the PDF route needs it, or null when it does not have the expected shape. */
export function staffStatementFrom(raw: unknown): StaffStatement | null {
  const head = headSchema.safeParse(raw);
  if (!head.success) return null;
  if (!head.data.allowed) return { state: "not-allowed" };
  if (head.data.partial) return { state: "partial" };
  if (head.data.refused === "company") return { state: "company" };
  if (head.data.refused === "not_found") return { state: "not-found" };
  const statement = publicStatementFrom(raw);
  if (!statement) return null;
  return { state: "ok", statement, bankElsewhere: head.data.bank_elsewhere === true };
}
