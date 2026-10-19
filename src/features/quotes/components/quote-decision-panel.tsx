"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, TextareaField, TextField } from "@/components/ui/field";

import { ACCEPT_WORDING, REASON_MAX, type DecisionBody } from "../decision";
import { SignaturePad } from "./signature-pad";

type Props = { token: string; fingerprint: string };
type Mode = "choose" | "accept" | "decline";

/**
 * QUO-09: on the customer's page of a quote that waits for an answer: accept and sign (full name, ID optional, a drawn or
 * typed signature, the checkbox) or decline with an optional reason. The answer names the fingerprint of the version shown,
 * so it applies to exactly what the customer read.
 */
export function QuoteDecisionPanel({ token, fingerprint }: Props) {
  const router = useRouter();
  const ids = useId();
  const [mode, setMode] = useState<Mode>("choose");
  const [name, setName] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [kind, setKind] = useState<"drawn" | "typed">("drawn");
  const [image, setImage] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const canAccept = name.trim().length >= 2 && agreed && (kind === "typed" || image !== null);

  function submit(body: DecisionBody) {
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/forms/quote/${encodeURIComponent(token)}/decide`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const answer = (await response.json()) as { ok: boolean; status?: string; message: string };
        if (answer.ok) {
          setNotice(answer.message);
          router.refresh();
          return;
        }
        setError(answer.message);
        // a newer version came in, or someone already answered: show the page as it is now
        if (answer.status === "changed" || answer.status === "already_decided") router.refresh();
      } catch {
        setError("אין חיבור לשרת כרגע. בדקו את החיבור לאינטרנט ונסו שוב.");
      }
    });
  }

  if (notice) return <FormNotice message={notice} className="print:hidden" />;

  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-4 rounded-lg border border-line bg-surface p-4 print:hidden sm:p-6">
      <h2 id={`${ids}-title`} className="text-lg font-semibold text-ink">
        התשובה שלך להצעה
      </h2>
      {mode === "choose" ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setMode("accept")}>אישור וחתימה</Button>
          <Button variant="secondary" onClick={() => setMode("decline")}>
            דחיית ההצעה
          </Button>
        </div>
      ) : mode === "accept" ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canAccept) return;
            submit({
              decision: "accepted",
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
          <TextField
            label="תעודת זהות (רשות)"
            value={idNumber}
            onChange={(event) => setIdNumber(event.currentTarget.value)}
            inputMode="numeric"
            dir="ltr"
            maxLength={12}
          />
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
          {/* DRAFT wording until the lawyer edits it (ACCEPT_WORDING) */}
          <Checkbox label={ACCEPT_WORDING} checked={agreed} onChange={(event) => setAgreed(event.currentTarget.checked)} />
          <p className="text-sm text-ink-soft">עם החתימה נשמרים השם, החתימה, השעה, כתובת ה-IP והדפדפן, כראיה לאישור.</p>
          <FormError message={error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={pending} disabled={!canAccept}>
              אישור וחתימה
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode("choose")} disabled={pending}>
              חזרה
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit({ decision: "rejected", fingerprint, reason: reason.trim() || null });
          }}
        >
          <TextareaField
            label="מה הסיבה? (רשות)"
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
            maxLength={REASON_MAX}
            rows={3}
          />
          <FormError message={error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" loading={pending}>
              דחיית ההצעה
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode("choose")} disabled={pending}>
              חזרה
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
