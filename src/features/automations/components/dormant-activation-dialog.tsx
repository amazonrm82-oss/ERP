"use client";

import { usePathname, useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

import { runDormantBackfillAction } from "../actions";
import { dormantCheckboxLabel, dormantQuestion, DORMANT_NOT_ASKED_LINE } from "../dormant-activation";

/**
 * RET-01, owner's answer (64) ג: right after a dormant-customer rule is switched on, asks with the number whether to run it
 * on the customers already dormant. The box starts unticked; "אישור" without it keeps the rule to new dormant customers.
 */
export function DormantActivationDialog({ orgId, automationId, count }: { orgId: string; automationId: string; count: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(true);
  const [run, setRun] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [pending, startTransition] = useTransition();
  const boxId = useId();

  function close() {
    setOpen(false);
    // the question is asked once: drop the parameter from the address
    router.replace(pathname, { scroll: false });
  }

  function confirm() {
    if (!run) {
      close();
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await runDormantBackfillAction(orgId, automationId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setMessage(result.message ?? null);
      setMore(result.data?.more === true);
    });
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="לקוחות שכבר רדומים"
      description={dormantQuestion(count)}
      footer={
        message ? (
          <>
            <Button variant={more ? "secondary" : "primary"} onClick={close} disabled={pending}>
              סגירה
            </Button>
            {more ? (
              <Button onClick={confirm} disabled={pending} aria-busy={pending || undefined}>
                {pending ? "מריצים…" : "להמשיך"}
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={close} disabled={pending}>
              לא עכשיו
            </Button>
            <Button onClick={confirm} disabled={pending} aria-busy={pending || undefined}>
              {pending ? "מריצים…" : "אישור"}
            </Button>
          </>
        )
      }
    >
      {message ? (
        <p role="status" className="text-md">
          {message}
        </p>
      ) : (
        <div className="space-y-2">
          <label htmlFor={boxId} className="flex items-start gap-2 text-md">
            <input id={boxId} type="checkbox" className="mt-1 size-4 shrink-0" checked={run} onChange={(e) => setRun(e.target.checked)} />
            <span>{dormantCheckboxLabel(count)}</span>
          </label>
          <p className="text-sm text-ink-soft">{DORMANT_NOT_ASKED_LINE}</p>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
