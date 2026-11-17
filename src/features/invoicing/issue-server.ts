import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/lib/database.types";

import type { IssueLine, IssueSourceKind } from "./issue";
import { requestSchema } from "./issue-handler";

// DOC-07 / DOC-09: the person's begin, with their own session (no service key). The database keeps one request per
// idempotency key, computes the totals and queues an `invoice.issue` job (migration invoice_issue); the worker asks the
// provider with the request's id as its idempotency key and the database records the document once (issue-handler.ts).

export type IssueInput = {
  key: string;
  kind: IssueSourceKind;
  id: string;
  doc: { doc_type: string; doc_date: string; due_date: string | null; prices_include_vat: boolean; lines: IssueLine[] };
};

export type IssueOutcome =
  | { status: "queued"; requestId: string; reused: boolean }
  | { status: "blocked"; problems: string[] }
  | { status: "failed"; reason: "answer" }
  | { status: "error"; error: { code?: string; message?: string; hint?: string } };

const beginSchema = z.union([
  z.object({ status: z.literal("blocked"), problems: z.array(z.string()) }),
  z.object({
    status: z.enum(["pending", "issued", "unrecorded", "failed", "stale"]),
    request_id: z.string(),
    provider: z.string(),
    reused: z.boolean().optional(),
    document_id: z.string().nullable().optional(),
    number: z.string().nullable().optional(),
    code: z.string().nullable().optional(),
    request: requestSchema,
  }),
]);

/**
 * DOC-07 (owner (398) א): the person's half: begin queues the request (the database judges everything and computes the
 * totals); the background worker asks the provider (issue-handler.ts). Answers the request to follow, or why not.
 */
export async function beginIssue(supabase: SupabaseClient<Database>, orgId: string, input: IssueInput): Promise<IssueOutcome> {
  const { data: begun, error } = await supabase.rpc("invoice_issue_begin", {
    p_org: orgId,
    p_key: input.key,
    p_kind: input.kind,
    p_id: input.id,
    p_doc: input.doc,
  });
  if (error) return { status: "error", error };
  const parsed = beginSchema.safeParse(begun);
  if (!parsed.success) return { status: "failed", reason: "answer" };
  const answer = parsed.data;
  if (answer.status === "blocked") return { status: "blocked", problems: answer.problems };
  return { status: "queued", requestId: answer.request_id, reused: answer.reused === true };
}

export type CreditOutcome =
  | { status: "queued"; requestId: string }
  | { status: "failed"; reason: "answer" }
  | { status: "error"; error: { code?: string; message?: string; hint?: string } };

const creditBeginSchema = z.object({
  status: z.enum(["pending", "issued", "unrecorded", "failed", "stale"]),
  request_id: z.string(),
  provider: z.string(),
});

/**
 * DOC-14: a credit invoice against one of the provider's documents, with the person's own session. The database judges the
 * person (app.can_issue_credits), what is left of the original, the VAT share and the lines, keeps one request per key and
 * queues the same `invoice.issue` job; the worker calls the provider's creditDocument (issue-handler.ts).
 */
export async function beginCredit(
  supabase: SupabaseClient<Database>,
  orgId: string,
  input: { key: string; documentId: string; reason: string; amountAgorot: number | null },
): Promise<CreditOutcome> {
  const { data, error } = await supabase.rpc("invoice_credit_begin", {
    p_org: orgId,
    p_key: input.key,
    p_document: input.documentId,
    p_credit: { reason: input.reason, amount_agorot: input.amountAgorot },
  });
  if (error) return { status: "error", error };
  const parsed = creditBeginSchema.safeParse(data);
  if (!parsed.success) return { status: "failed", reason: "answer" };
  return { status: "queued", requestId: parsed.data.request_id };
}
