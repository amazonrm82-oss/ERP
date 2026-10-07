"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { MfaGate } from "@/features/auth/components/mfa-gate";
import { createClient } from "@/lib/supabase/client";

type State = { kind: "loading" } | { kind: "on"; factorId: string } | { kind: "off" } | { kind: "setup" };

/** Two-step verification for the signed-in user: on (with a way to turn it off) or off (with set-up). */
export function MfaSettings({ orgRequires }: { orgRequires: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function readState(): Promise<State> {
    // from the server, not the session's copy (it can predate a change made on another device)
    const { data } = await createClient().auth.getUser();
    const verified = data.user?.factors?.find((f) => f.factor_type === "totp" && f.status === "verified");
    return verified ? { kind: "on", factorId: verified.id } : { kind: "off" };
  }

  async function load() {
    setState(await readState());
  }

  useEffect(() => {
    let cancelled = false;
    readState().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function turnOff(factorId: string) {
    setError(null);
    const supabase = createClient();
    const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId });
    if (unenrollError) {
      setError("לא הצלחנו לכבות. התנתקו, התחברו שוב עם הקוד ונסו שוב.");
      return;
    }
    await supabase.auth.refreshSession();
    setConfirming(false);
    await load();
    router.refresh();
  }

  if (state.kind === "loading") return <p role="status">בודק…</p>;
  if (state.kind === "setup") {
    return <MfaGate onDone={() => void load()} />;
  }
  return (
    <div className="space-y-3">
      <p role="status" className="font-medium">
        {state.kind === "on" ? "אימות דו-שלבי פעיל בחשבון שלך." : "אימות דו-שלבי כבוי."}
      </p>
      <p className="text-sm text-ink-soft">
        בכל כניסה, אחרי הסיסמה, מזינים קוד מאפליקציית אימות בטלפון (Google Authenticator, Microsoft Authenticator או 1Password). כך סיסמה שדלפה לבדה לא מספיקה.
      </p>
      {state.kind === "off" ? (
        <Button onClick={() => setState({ kind: "setup" })}>הפעלת אימות דו-שלבי</Button>
      ) : confirming ? (
        <span role="group" aria-label="אישור כיבוי" className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{orgRequires ? "העסק מחייב אימות דו-שלבי: אחרי הכיבוי לא תוכלו להיכנס אליו עד שתפעילו שוב." : "לכבות את האימות הדו-שלבי?"}</span>
          <Button variant="danger" size="sm" onClick={() => void turnOff(state.factorId)}>
            כיבוי
          </Button>
          <Button variant="secondary" size="sm" autoFocus onClick={() => setConfirming(false)}>
            ביטול
          </Button>
        </span>
      ) : (
        <Button variant="danger-ghost" onClick={() => setConfirming(true)}>
          כיבוי אימות דו-שלבי
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
