"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { customerProblemsText, ISSUE_FIELD_NAMES, ISSUE_SOURCE_KINDS, issueFormSchema, issueTakesDueDate, parseIssueLines, type IssueSourceKind } from "./issue";
import { beginIssue } from "./issue-server";
import { issueRequestPath, issueSourcePath } from "./paths";

// DOC-07 / DOC-09: issuing through the business's invoice provider, with the user's own session (DOC-17's issuers; the
// database decides).

const sourceSchema = z.object({ kind: z.enum(ISSUE_SOURCE_KINDS), id: z.guid() });

/** DOC-07: queue the document (owner (398) א: the provider is asked in the background); then to the request's page. */
export async function issueDocumentAction(
  orgId: string,
  source: { kind: IssueSourceKind; id: string },
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!validArg(sourceSchema, source)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, source.id);
  if (!context.ok) return context;
  const parsed = issueFormSchema.safeParse(pick(formData, [...ISSUE_FIELD_NAMES]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const lines = parseIssueLines(String(formData.get("lines") ?? ""));
  if (!lines.ok) return fail(lines.message, { values: formValues(formData) });
  const dueDate = issueTakesDueDate(parsed.data.doc_type) && parsed.data.due_date !== "" ? parsed.data.due_date : null;
  const outcome = await beginIssue(context.supabase, orgId, {
    key: parsed.data.key,
    kind: source.kind,
    id: source.id,
    doc: {
      doc_type: parsed.data.doc_type,
      doc_date: parsed.data.doc_date,
      due_date: dueDate,
      prices_include_vat: formData.get("prices_include_vat") === "true",
      lines: lines.lines,
    },
  });
  const values = formValues(formData);
  switch (outcome.status) {
    case "error":
      return fail(dbErrorMessage(outcome.error), { values });
    case "blocked":
      return fail(["אי אפשר להפיק עדיין:", ...customerProblemsText(outcome.problems)].join(" "), { values });
    case "failed":
      return fail("תשובה לא צפויה. נסו שוב.", { values });
    case "queued":
      break;
  }
  // owner (398) א: the provider is asked in the background; the request's page shows it waiting, then the document. A reload
  // within 15 minutes reached the person's earlier request (rule 5): the page says so.
  revalidatePath(issueSourcePath(orgId, source.kind, source.id));
  redirect(issueRequestPath(orgId, outcome.requestId, outcome.reused));
}
