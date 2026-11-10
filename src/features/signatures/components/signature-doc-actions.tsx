"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/field";
import type { DocumentRecordType } from "@/features/document-templates/fields";

import { cancelSignatureDocumentAction, makeSignedDocumentPdfAction, newSignatureLinkAction } from "../actions";
import { signatureWhatsappHref } from "../states";

type Props = {
  orgId: string;
  kind: DocumentRecordType;
  recordId: string;
  docId: string;
  title: string;
  // the document waits for its signature: a new link and cancelling are offered
  waiting: boolean;
  // signed, no PDF kept yet, and the reader is an owner or admin
  canMakePdf: boolean;
  businessName: string;
  phoneE164: string | null;
};

/** SGN-02: a document's actions on the record's card (whoever may edit the record; the database decides again). */
export function SignatureDocActions({ orgId, kind, recordId, docId, title, waiting, canMakePdf, businessName, phoneE164 }: Props) {
  const router = useRouter();
  const inputId = useId();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function newLink() {
    setError(null);
    const result = await newSignatureLinkAction(orgId, kind, recordId, docId);
    if (!result.ok) return result;
    setUrl(result.data?.url ?? null);
    return { ok: true as const };
  }

  async function makePdf() {
    setBusy(true);
    setError(null);
    const result = await makeSignedDocumentPdfAction(orgId, kind, recordId, docId);
    setBusy(false);
    if (!result.ok) setError(result.message);
    else router.refresh();
  }

  if (url) {
    return (
      <div className="mt-2 space-y-2">
        <Label htmlFor={inputId}>הקישור החדש</Label>
        <Input id={inputId} dir="ltr" readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="font-mono text-sm" />
        <div className="flex flex-wrap gap-2">
          <a className={buttonClasses("secondary", "sm")} href={signatureWhatsappHref(url, title, businessName, phoneE164)} target="_blank" rel="noopener noreferrer">
            שליחה ב-WhatsApp
            <span className="sr-only"> (נפתח בחלון חדש)</span>
          </a>
          <Button size="sm" variant="ghost" onClick={() => setUrl(null)}>
            סיום
          </Button>
        </div>
      </div>
    );
  }

  if (!waiting && !canMakePdf) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {waiting ? (
        <>
          <ConfirmButton
            variant="secondary"
            size="sm"
            title="ליצור קישור חדש?"
            description="הקישור הקודם יפסיק לעבוד מיד."
            confirmLabel="יצירת קישור חדש"
            action={newLink}
          >
            קישור חדש
          </ConfirmButton>
          <ConfirmButton
            size="sm"
            title="לבטל את המסמך?"
            description="הלקוח לא יוכל לחתום עליו. בקישור יופיע שהמסמך בוטל."
            confirmLabel="ביטול המסמך"
            action={cancelSignatureDocumentAction.bind(null, orgId, kind, recordId, docId)}
            onDone={() => router.refresh()}
          >
            ביטול
          </ConfirmButton>
        </>
      ) : null}
      {canMakePdf ? (
        <Button size="sm" variant="secondary" onClick={() => void makePdf()} loading={busy}>
          יצירת PDF חתום
        </Button>
      ) : null}
      <FormError message={error} />
    </div>
  );
}
