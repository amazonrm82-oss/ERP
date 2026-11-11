"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, TextField } from "@/components/ui/field";
import { SignaturePad } from "@/features/quotes/components/signature-pad";

import { publicSignatureSignPath, SIGN_WORDING, type SignBody } from "../public";

// SGN-07: the reply of whoever receives the signature (the customer's route, or the rep's in-person action)
export type SignReply = { ok: boolean; status?: string; message: string };
type Props = {
  token?: string;
  fingerprint: string;
  // SGN-07: in-person signing posts through the rep's own action instead of the customer's route
  send?: (body: SignBody) => Promise<SignReply>;
  // what is kept with the signature, said under the box
  evidence?: string;
  // what to show once signed (default: the reply's message)
  done?: (reply: SignReply) => ReactNode;
};

/**
 * SGN-02: on the customer's page of a document that waits for a signature: full name, ID (optional), a drawn or typed
 * signature and the checkbox. The signature names the fingerprint of the document shown, so it applies to exactly what the
 * customer read.
 */
export function SignPanel({ token, fingerprint, send, evidence, done }: Props) {
  const router = useRouter();
  const ids = useId();
  const [name, setName] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [kind, setKind] = useState<"drawn" | "typed">("drawn");
  const [image, setImage] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<SignReply | null>(null);
  const [pending, startTransition] = useTransition();

  const canSign = name.trim().length >= 2 && agreed && (kind === "typed" || image !== null);

  function submit(body: SignBody) {
    setError(null);
    startTransition(async () => {
      try {
        let answer: SignReply;
        if (send) {
          answer = await send(body);
        } else {
          const response = await fetch(publicSignatureSignPath(token ?? ""), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          answer = (await response.json()) as SignReply;
        }
        if (answer.ok) {
          setNotice(answer);
          router.refresh();
          return;
        }
        setError(answer.message);
        if (answer.status === "changed" || answer.status === "already_signed" || answer.status === "closed") router.refresh();
      } catch {
        setError("אין חיבור לשרת כרגע. בדקו את החיבור לאינטרנט ונסו שוב.");
      }
    });
  }

  if (notice) return done ? <>{done(notice)}</> : <FormNotice message={notice.message} className="print:hidden" />;

  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-4 rounded-lg border border-line bg-surface p-4 print:hidden sm:p-6">
      <h2 id={`${ids}-title`} className="text-lg font-semibold text-ink">
        חתימה על המסמך
      </h2>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSign) return;
          submit({
            fingerprint,
            signerName: name.trim(),
            idNumber: idNumber.trim() || null,
            signatureKind: kind,
            signatureImage: kind === "drawn" ? image : null,
            agreed: true,
          });
        }}
      >
        <TextField label="שם מלא" required value={name} onChange={(event) => setName(event.currentTarget.value)} autoComplete="name" maxLength={120} />
        <TextField label="תעודת זהות (רשות)" value={idNumber} onChange={(event) => setIdNumber(event.currentTarget.value)} inputMode="numeric" dir="ltr" maxLength={12} />
        <fieldset className="space-y-2">
          <legend id={`${ids}-sig`} className="text-md font-medium text-ink">
            חתימה
          </legend>
          <div className="flex flex-wrap gap-4 text-md">
            <label className="flex items-center gap-2">
              <input type="radio" name="kind" checked={kind === "drawn"} onChange={() => setKind("drawn")} />
              ציור באצבע או בעכבר
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="kind" checked={kind === "typed"} onChange={() => setKind("typed")} />
              השם המלא שהקלדתי
            </label>
          </div>
          {kind === "drawn" ? (
            <SignaturePad labelId={`${ids}-sig`} onChange={setImage} />
          ) : (
            <p className="rounded-md border border-line-control px-3 py-4 text-lg text-ink">
              <bdi>{name.trim() || "השם יופיע כאן"}</bdi>
            </p>
          )}
        </fieldset>
        {/* DRAFT wording until the lawyer edits it (SIGN_WORDING, SIGN_WORDING_VERSION) */}
        <Checkbox label={SIGN_WORDING} checked={agreed} onChange={(event) => setAgreed(event.currentTarget.checked)} />
        <p className="text-sm text-ink-soft">{evidence ?? "עם החתימה נשמרים השם, החתימה, השעה, כתובת ה-IP והדפדפן, כראיה לחתימה."}</p>
        <FormError message={error} />
        <Button type="submit" loading={pending} disabled={!canSign}>
          חתימה על המסמך
        </Button>
      </form>
    </section>
  );
}
