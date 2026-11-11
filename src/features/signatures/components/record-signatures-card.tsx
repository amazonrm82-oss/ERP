import { Badge, type BadgeTone } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { DocumentRecordType } from "@/features/document-templates/fields";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate } from "@/lib/format";
import { paths } from "@/lib/paths";

import { signatureDayText } from "../public";
import { listRecordSignatureDocuments, listSendableTemplates } from "../queries";
import { awaitsSignature, SIGNATURE_STATE_LABELS, shownSignatureState, signatureDatesLine, TEXT_ERASED_LINE, type ShownSignatureState } from "../states";
import { SignatureDocActions } from "./signature-doc-actions";
import { SignatureSendPanel } from "./signature-send-panel";

type Props = {
  orgId: string;
  kind: DocumentRecordType;
  recordId: string;
  // the person may edit the record (the database decides again)
  canEdit: boolean;
  // the customer's number for the WhatsApp message (E.164), if any
  phoneE164?: string | null;
};

const TONES: Record<ShownSignatureState, BadgeTone> = {
  sent: "accent",
  viewed: "accent",
  signed: "success",
  cancelled: "neutral",
  expired: "warning",
};

/**
 * SGN-02: "מסמכים לחתימה" on a lead, contact, company or deal: the documents sent from this record with their state, and
 * "מסמך לחתימה" for whoever may edit it while the plan holds `signatures`. A signed document's PDF (kept in the record's files
 * by the server) is read by owners and admins only, as a signed quote's (owner (37) ב's safe side).
 */
export async function RecordSignaturesCard({ orgId, kind, recordId, canEdit, phoneE164 = null }: Props) {
  const [inPlan, docs, context] = await Promise.all([
    orgHasFeature(orgId, "signatures"),
    listRecordSignatureDocuments(orgId, kind, recordId),
    getOrgContext(orgId),
  ]);
  const canSend = inPlan && canEdit && context.canWrite;
  const templates = canSend ? await listSendableTemplates(orgId, kind) : [];
  if (docs.length === 0 && !canSend) return null;
  const isAdmin = isAdminRole(context.role);
  const titleId = `signatures-${recordId}`;
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader id={titleId} title="מסמכים לחתימה" />
      <CardBody className="space-y-3">
        {docs.length > 0 ? (
          <ul className="divide-y divide-line">
            {docs.map((doc) => {
              const state = shownSignatureState(doc);
              return (
                <li key={doc.id} className="py-2 first:pt-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-ink">
                      <bdi>{doc.title}</bdi>
                    </span>
                    <Badge tone={TONES[state]}>{SIGNATURE_STATE_LABELS[state]}</Badge>
                  </div>
                  <p className="text-sm text-ink-soft">
                    {signatureDatesLine(doc, state, formatDate, (iso) => signatureDayText(iso, context.org.timeZone))}
                  </p>
                  {doc.textErased ? <p className="text-sm text-ink-soft">{TEXT_ERASED_LINE}</p> : null}
                  {doc.fileId ? (
                    <a href={paths.file(orgId, doc.fileId)} className={`${buttonClasses("secondary", "sm")} mt-2`}>
                      הורדת PDF חתום
                    </a>
                  ) : null}
                  {isAdmin && state === "signed" && !doc.fileId && !doc.erased ? (
                    <p className="mt-1 text-sm text-ink-soft">
                      ה-PDF החתום עוד לא נשמר. אם האחסון של העסק מלא, הוא לא יישמר עד שמפנים מקום או משדרגים את החבילה.
                    </p>
                  ) : null}
                  {canSend ? (
                    <SignatureDocActions
                      orgId={orgId}
                      kind={kind}
                      recordId={recordId}
                      docId={doc.id}
                      title={doc.title}
                      waiting={awaitsSignature(doc)}
                      canMakePdf={isAdmin && state === "signed" && !doc.fileId && !doc.erased}
                      businessName={context.org.name}
                      phoneE164={phoneE164}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-ink-soft">מסמך מתבנית, עם הפרטים של הרשומה, נשלח ללקוח בקישור. הלקוח קורא וחותם מהטלפון, וה-PDF החתום נשמר כאן.</p>
        )}
        {docs.some((doc) => doc.status === "signed") && !isAdmin ? (
          <p className="text-sm text-ink-soft">את ה-PDF החתום רואים בעלים ומנהלי מערכת.</p>
        ) : null}
        {canSend ? (
          templates.length > 0 ? (
            <SignatureSendPanel orgId={orgId} kind={kind} recordId={recordId} templates={templates} businessName={context.org.name} phoneE164={phoneE164} />
          ) : (
            <p className="text-sm text-ink-soft">אין תבנית מסמך פעילה לסוג הרשומה הזה. בעלים ומנהלי מערכת מוסיפים תבניות בהגדרות.</p>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}
