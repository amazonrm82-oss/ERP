"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { createClient } from "@/lib/supabase/client";

type Step = { kind: "loading" } | { kind: "enroll"; factorId: string; qr: string; secret: string } | { kind: "verify"; factorId: string };

/**
 * Two-step verification for platform staff (Supabase MFA, TOTP). The database
 * accepts platform calls only from a session that passed it (aal2).
 */
export function MfaGate() {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) throw listError;
      const verified = data.totp.find((f) => f.status === "verified");
      if (verified) {
        if (!cancelled) setStep({ kind: "verify", factorId: verified.id });
        return;
      }
      // an enrollment that was started and never finished blocks a new one
      for (const factor of data.all.filter((f) => f.status === "unverified")) {
        await supabase.auth.mfa.unenroll({ factorId: factor.id });
      }
      const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `ניהול ${Date.now()}` });
      if (enrollError?.code === "mfa_totp_enroll_not_enabled") {
        if (!cancelled) setError("אימות דו-שלבי כבוי בפרויקט Supabase. יש להפעיל אותו ב-Authentication ← Multi-Factor (TOTP).");
        return;
      }
      if (enrollError) throw enrollError;
      if (!cancelled) setStep({ kind: "enroll", factorId: enrolled.id, qr: enrolled.totp.qr_code, secret: enrolled.totp.secret });
    })().catch(() => {
      if (!cancelled) setError("לא הצלחנו להתחיל את האימות הדו-שלבי. רעננו את הדף ונסו שוב.");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function verify(factorId: string) {
    setError(null);
    if (!/^\d{6}$/.test(code.trim())) {
      setError("יש להזין את 6 הספרות מהאפליקציה.");
      return;
    }
    setBusy(true);
    const { error: verifyError } = await createClient().auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    setBusy(false);
    if (verifyError) {
      setError("הקוד לא התאים. בדקו שהשעה בטלפון נכונה ונסו את הקוד הבא.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-md space-y-4 rounded-lg border border-line bg-surface p-5">
      <h1 className="text-xl font-semibold">אימות דו-שלבי</h1>
      {step.kind === "loading" && !error ? <p role="status">טוען…</p> : null}
      {step.kind === "enroll" ? (
        <>
          <p className="text-[0.9375rem]">
            פאנל הניהול דורש אימות דו-שלבי. סרקו את הקוד באפליקציית אימות (Google Authenticator, Microsoft Authenticator או 1Password) והזינו את 6 הספרות שהיא מציגה.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL from Supabase, nothing to optimize */}
          <img src={step.qr} alt="קוד QR לחיבור אפליקציית האימות" className="mx-auto size-48 rounded-md bg-white p-2" />
          <p className="text-sm text-ink-soft">
            אי אפשר לסרוק? הזינו באפליקציה את המפתח:{" "}
            <code dir="ltr" className="break-all">
              {step.secret}
            </code>
          </p>
        </>
      ) : null}
      {step.kind === "verify" ? <p className="text-[0.9375rem]">הזינו את 6 הספרות מאפליקציית האימות.</p> : null}
      {step.kind !== "loading" ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void verify(step.factorId);
          }}
        >
          <TextField
            label="קוד אימות"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            dir="ltr"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
            {busy ? "בודק…" : "אימות"}
          </Button>
        </form>
      ) : null}
      <FormError message={error} />
    </div>
  );
}
