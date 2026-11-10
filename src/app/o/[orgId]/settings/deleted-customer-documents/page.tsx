import type { Metadata } from "next";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { Pagination } from "@/components/ui/pagination";
import { NoteText } from "@/features/activities/components/note-text";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { detachedSignatureDocumentsPath } from "@/features/signatures/paths";
import { listDetachedSignatureDocuments } from "@/features/signatures/queries";
import { SIGNATURE_STATE_LABELS, shownSignatureState, TEXT_ERASED_LINE, type ShownSignatureState } from "@/features/signatures/states";
import { formatDate } from "@/lib/format";
import { paths } from "@/lib/paths";
import { parsePage } from "@/lib/search";

export const metadata: Metadata = { title: "מסמכים ללא רשומה" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ page?: string }>;
};

const TONES: Record<ShownSignatureState, BadgeTone> = {
  sent: "accent",
  viewed: "accent",
  signed: "success",
  cancelled: "neutral",
  expired: "warning",
};

/**
 * SGN-02 (235) ב: a document for signature stays when its record is deleted permanently (owner (219) ב), detached from it.
 * Owners, admins and managers by role read such documents (the select policy decides again), and this is where they find
 * them, as the quotes of deleted customers. The signed PDF is shown to owners and admins only (the files policy).
 */
export default async function DeletedCustomerDocumentsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const page = parsePage((await searchParams).page);
  const { role } = await getOrgContext(orgId);
  if (!isAdminRole(role) && role !== "manager") {
    return (
      <Card>
        <EmptyState kind="locked" title="פנו לבעלים של העסק" description="מסמכים שהרשומה שלהם נמחקה רואים הבעלים, מנהלי המערכת ומנהלי הצוותים של העסק." />
      </Card>
    );
  }
  const { docs, hasMore } = await listDetachedSignatureDocuments(orgId, page);
  const hrefFor = (target: number) => (target > 1 ? `${detachedSignatureDocumentsPath(orgId)}?page=${target}` : detachedSignatureDocumentsPath(orgId));

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-soft">
        מסמך לחתימה נשאר גם כשהרשומה שנשלח ממנה נמחקה לצמיתות. כאן הם מרוכזים. מסמך של לקוח שנמחקו פרטיו לבקשתו מופיע בלי התוכן.
      </p>
      {docs.length === 0 ? (
        <Card>
          <EmptyState title="אין מסמכים ללא רשומה" description="כשתימחק לצמיתות רשומה שנשלח ממנה מסמך לחתימה, המסמך יופיע כאן." />
        </Card>
      ) : (
        <ul aria-label="מסמכים ללא רשומה" className="divide-y divide-line rounded-lg border border-line bg-surface">
          {docs.map((doc) => {
            const state = shownSignatureState(doc);
            return (
              <li key={doc.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 font-medium text-ink">
                    <bdi>{doc.title}</bdi>
                  </span>
                  <Badge tone={TONES[state]}>{SIGNATURE_STATE_LABELS[state]}</Badge>
                </div>
                <p className="text-sm text-ink-soft">
                  {`נשלח ב-${formatDate(doc.sentAt)}`}
                  {doc.signedAt ? ` · נחתם ב-${formatDate(doc.signedAt)}` : ""}
                  {doc.cancelledAt ? ` · בוטל ב-${formatDate(doc.cancelledAt)}` : ""}
                  {` · הרשומה נמחקה ${formatDate(doc.customerDeletedAt)}`}
                </p>
                {doc.textErased ? <p className="text-sm text-ink-soft">{TEXT_ERASED_LINE}</p> : null}
                {/* the text is hidden only when the person's own erasure emptied it */}
                {doc.emptied ? null : (
                  <details>
                    <summary className="cursor-pointer text-sm font-medium text-accent-strong">הצגת המסמך</summary>
                    <div className="mt-2 rounded-md border border-line bg-canvas p-3">
                      <NoteText text={doc.body} className="text-md text-ink" />
                    </div>
                  </details>
                )}
                {doc.fileId ? (
                  <a href={paths.file(orgId, doc.fileId)} className={buttonClasses("secondary", "sm")}>
                    הורדת PDF חתום
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {docs.some((doc) => doc.status === "signed") && !isAdminRole(role) ? (
        <p className="text-sm text-ink-soft">את ה-PDF החתום רואים בעלים ומנהלי מערכת.</p>
      ) : null}
      <Pagination page={page} hasMore={hasMore} hrefFor={hrefFor} />
    </div>
  );
}
