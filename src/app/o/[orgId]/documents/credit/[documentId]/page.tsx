import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormNotice } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { DOCUMENT_TYPE_LABELS } from "@/features/documents/schema";
import { CreditForm, ReleaseCreditButton } from "@/features/invoicing/components/credit-form";
import { creditBackLabel, creditBlockedText } from "@/features/invoicing/credit";
import { issueSourcePath } from "@/features/invoicing/paths";
import { getCreditRoom, getInvoicingAccess } from "@/features/invoicing/queries";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { formatDate, formatMoney, zoneDate, zoneTime } from "@/lib/format";
import { isUuid } from "@/lib/paths";

export const metadata: Metadata = { title: "חשבונית זיכוי" };

type Props = { params: Promise<{ orgId: string; documentId: string }> };

/**
 * DOC-14: a credit invoice through the business's invoice provider against a tax invoice or a tax invoice-receipt the
 * provider issued: full or partial, always with a reason, never more than what is left. Hidden (not found) unless this
 * deployment offers a provider, the business is connected and the person may credit (owners, admins, `issue_credits`).
 */
export default async function CreditDocumentPage({ params }: Props) {
  const { orgId, documentId } = await params;
  if (!isUuid(documentId)) notFound();
  const access = await getInvoicingAccess(orgId);
  if (!access.canCredit) notFound();
  const [room, terms, context] = await Promise.all([getCreditRoom(orgId, documentId), getOrgTerms(orgId), getOrgContext(orgId)]);
  if (!room) notFound();
  const timeZone = context.org.timeZone;
  const typeLabel = room.docType in DOCUMENT_TYPE_LABELS ? DOCUMENT_TYPE_LABELS[room.docType as keyof typeof DOCUMENT_TYPE_LABELS] : "מסמך";
  const back = room.back ? { href: issueSourcePath(orgId, room.back.kind, room.back.id), label: creditBackLabel(room.back.kind, terms) } : undefined;
  return (
    <div className="space-y-5">
      <PageHeader title="חשבונית זיכוי" description={`${typeLabel} ${room.number}`} back={back} />
      <Card aria-labelledby="credit-original">
        <CardHeader id="credit-original" title="המסמך המקורי" />
        <CardBody className="space-y-3 text-sm">
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            <dt>{typeLabel}</dt>
            <dd>
              <bdi dir="ltr" className="tabular-nums">
                {room.number}
              </bdi>
            </dd>
            <dt>{'סכום המסמך כולל מע"מ'}</dt>
            <dd className="tabular-nums">{formatMoney(room.amountAgorot)}</dd>
            <dt>כבר זוכה</dt>
            <dd className="tabular-nums">{formatMoney(room.creditedAgorot)}</dd>
            {room.pendingAgorot > 0 ? (
              <>
                <dt>בקשות זיכוי שממתינות לספק</dt>
                <dd className="tabular-nums">{formatMoney(room.pendingAgorot)}</dd>
              </>
            ) : null}
            <dt className="font-medium">נשאר לזכות</dt>
            <dd className="font-medium tabular-nums">{formatMoney(room.leftAgorot)}</dd>
          </dl>
          {room.reserving.length > 0 ? (
            <section aria-labelledby="credit-reserving" className="space-y-2 border-t border-line pt-3">
              <h2 id="credit-reserving" className="font-medium">
                בקשות זיכוי שמחזיקות סכום
              </h2>
              <p className="text-ink-soft">בקשה שאולי הופקה אצל הספק מחזיקה את הסכום שלה עד שהיא נרשמת, עד שהמערכת יודעת שלא הופקה, או עד שבעלים או מנהל מערכת משחררים אותה.</p>
              <ul className="divide-y divide-line">
                {room.reserving.map((request) => (
                  <li key={request.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="tabular-nums">{request.totalAgorot !== null ? formatMoney(request.totalAgorot) : ""}</span>
                      {" · "}
                      {request.status === "pending" ? "ממתינה לספק" : "הסתיימה בלי מסמך רשום"}
                      {" · "}
                      <span className="text-ink-soft">{formatDate(zoneDate(new Date(request.createdAt), timeZone))} {zoneTime(new Date(request.createdAt), timeZone)}</span>
                    </span>
                    {access.canManage && request.status !== "pending" ? <ReleaseCreditButton orgId={orgId} documentId={documentId} requestId={request.id} /> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </CardBody>
      </Card>
      <Card aria-labelledby="credit-new">
        <CardHeader id="credit-new" title="זיכוי חדש" />
        <CardBody>
          {room.creditable ? (
            <CreditForm orgId={orgId} documentId={documentId} idempotencyKey={randomUUID()} leftAgorot={room.leftAgorot} mixed={room.mixed && room.gross !== null} lines={room.lines} />
          ) : (
            <FormNotice message={creditBlockedText(room.code)} />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
