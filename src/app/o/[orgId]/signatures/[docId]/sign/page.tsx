import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/ui/page-header";
import { NoteText } from "@/features/activities/components/note-text";
import { InPersonDocumentSign } from "@/features/in-person-signing/components/in-person-document";
import { IN_PERSON_HAND_OVER, recordPathOf } from "@/features/in-person-signing/texts";
import { signatureDayText } from "@/features/signatures/public";
import { awaitsSignature, type SignatureStatus } from "@/features/signatures/states";
import { getOrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { isUuid } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "חתימה במקום", referrer: "no-referrer" };

type Props = { params: Promise<{ orgId: string; docId: string }> };

/**
 * SGN-07 (owner, 11 November 2026, answer (276) א): a document for signature, opened on the rep's device so the customer
 * reads it and signs with a finger. Read with the rep's session (the document follows its record's readers); whether the
 * rep may have it signed is decided by the database when the signature is sent (the right that sends the document).
 */
export default async function InPersonDocumentPage({ params }: Props) {
  const { orgId, docId } = await params;
  if (!isUuid(docId)) notFound();
  const context = await getOrgContext(orgId);
  const supabase = await createClient();
  const doc = must(
    await supabase
      .from("signature_documents")
      .select("id, title, body, status, expires_at, content_sha256, erased_at, lead_id, contact_id, company_id, deal_id")
      .eq("organization_id", orgId)
      .eq("id", docId)
      .maybeSingle(),
    "in-person document",
  );
  if (!doc) notFound();
  const recordPath = recordPathOf(orgId, doc);
  const back = recordPath ? { href: recordPath, label: "חזרה לרשומה" } : { href: `/o/${orgId}`, label: "חזרה" };
  const waiting = doc.erased_at === null && awaitsSignature({ status: doc.status as SignatureStatus, expiresAt: doc.expires_at });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={doc.title} back={back} />
      {!context.canWrite ? (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          אין לכם הרשאה להחתים את הלקוח במקום.
        </p>
      ) : !waiting ? (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          {doc.status === "signed" ? "המסמך כבר נחתם." : doc.status === "cancelled" ? "המסמך בוטל." : "המסמך כבר לא מחכה לחתימה."}
        </p>
      ) : (
        <p className="rounded-md bg-accent-soft px-3 py-2.5 text-sm text-ink">{IN_PERSON_HAND_OVER}</p>
      )}
      {waiting && doc.expires_at ? <p className="text-sm text-ink-soft">{`בתוקף עד ${signatureDayText(doc.expires_at, context.org.timeZone)}.`}</p> : null}
      <article className="rounded-lg border border-line bg-surface p-4 sm:p-6">
        <NoteText text={doc.body} className="text-md text-ink" />
      </article>
      {waiting && context.canWrite ? <InPersonDocumentSign orgId={orgId} docId={doc.id} fingerprint={doc.content_sha256} back={back} /> : null}
    </div>
  );
}
