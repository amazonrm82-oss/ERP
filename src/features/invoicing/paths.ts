import { moneySubjectPath } from "@/features/payments/money-subject";
import { quotePath } from "@/features/quotes/paths";

/** The four sources a document is issued from (ISSUE_SOURCE_KINDS in issue.ts). */
type IssueSourceKind = "deal" | "contact" | "quote" | "order";

export const invoicingSettingsPath = (orgId: string) => `/o/${orgId}/settings/invoicing`;

/** DOC-07: the issue page for one source (a deal, a contact, an accepted quote or a numbered order). */
export const issueDocumentPath = (orgId: string, kind: IssueSourceKind, id: string) =>
  `/o/${orgId}/documents/issue?from=${kind}&id=${id}`;

/** DOC-07 (owner (398) א): one issue request, waiting for the background worker and then its document. */
export const issueRequestPath = (orgId: string, requestId: string, reused = false) =>
  `/o/${orgId}/documents/issue/${requestId}${reused ? "?reused=1" : ""}`;

/** Where the person returns after issuing: the source's own page, where the document card lists it. */
export function issueSourcePath(orgId: string, kind: IssueSourceKind, id: string): string {
  return kind === "quote" ? quotePath(orgId, id) : moneySubjectPath(orgId, { kind, id });
}
