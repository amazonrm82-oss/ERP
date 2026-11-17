import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { AllocationFailureMark } from "@/features/documents/components/document-details";
import { DOCUMENT_TYPE_LABELS } from "@/features/documents/schema";
import { IssueRequestWaiting } from "@/features/invoicing/components/issue-request-waiting";
import { issueEndedText } from "@/features/invoicing/issue";
import { issueSourcePath } from "@/features/invoicing/paths";
import { getInvoicingAccess, getIssuedDocumentAllocation, getIssueRequest } from "@/features/invoicing/queries";
import { formatMoney } from "@/lib/format";
import { isUuid } from "@/lib/paths";

export const metadata: Metadata = { title: "הפקת מסמך" };

type Props = {
  params: Promise<{ orgId: string; requestId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * DOC-07 (owner (398) א): one issue request. The background worker asks the provider; the page shows it waiting, then the
 * document's number, or why it ended without one. Its requester, or an owner/admin, reads it (public.invoice_issue_state).
 */
export default async function IssueRequestPage({ params, searchParams }: Props) {
  const { orgId, requestId } = await params;
  const query = await searchParams;
  if (!isUuid(requestId)) notFound();
  const access = await getInvoicingAccess(orgId);
  if (!access.offered || !access.inPlan) notFound();
  const request = await getIssueRequest(orgId, requestId);
  if (!request) notFound();
  const back = request.sourceKind && request.sourceId && isUuid(request.sourceId) ? issueSourcePath(orgId, request.sourceKind, request.sourceId) : null;
  const typeLabel = request.docType && request.docType in DOCUMENT_TYPE_LABELS ? DOCUMENT_TYPE_LABELS[request.docType as keyof typeof DOCUMENT_TYPE_LABELS] : "מסמך";
  const ended = issueEndedText(request.status, request.code, request.number);
  // DOC-10: the allocation number the provider got, or why it did not
  const allocation = request.status === "issued" && request.documentId && isUuid(request.documentId) ? await getIssuedDocumentAllocation(orgId, request.documentId) : null;
  return (
    <div className="space-y-5">
      <PageHeader title="הפקת מסמך" description={typeLabel} back={back ? { href: back, label: "חזרה" } : undefined} />
      <Card aria-labelledby="issue-request">
        <CardHeader id="issue-request" title={request.status === "issued" ? "המסמך הופק" : request.status === "pending" ? "ממתין לספק" : "המסמך לא נרשם"} />
        <CardBody className="space-y-3 text-sm">
          {query.reused === "1" ? (
            <FormNotice message="נמצאה בקשת הפקה קודמת שלך למסמך הזה מהדקות האחרונות. זו הבקשה שמוצגת כאן, ולא הטופס ששלחת עכשיו: בדקו אותה לפני שמפיקים מסמך נוסף." />
          ) : null}
          {request.totalAgorot !== null ? <p>{`סה"כ: ${formatMoney(request.totalAgorot)}`}</p> : null}
          {request.status === "pending" ? <IssueRequestWaiting /> : null}
          {request.status === "issued" ? <p>{`${typeLabel} מספר ${request.number ?? ""} הופק ונרשם במערכת.`}</p> : null}
          {allocation?.allocationNumber ? (
            <p>
              מספר הקצאה{" "}
              <bdi dir="ltr" className="tabular-nums">
                {allocation.allocationNumber}
              </bdi>
            </p>
          ) : null}
          {allocation ? <AllocationFailureMark doc={allocation} /> : null}
          {ended ? <FormError message={ended} /> : null}
          {back && request.status !== "pending" ? (
            <Link href={back} className="text-accent underline">
              חזרה לרשומה
            </Link>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
