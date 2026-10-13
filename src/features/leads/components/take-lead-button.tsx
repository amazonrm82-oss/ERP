"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { CheckIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

import { takeLeadAction } from "../take-actions";

type Props = { orgId: string; leadId: string; leadName: string; size?: "md" | "sm"; className?: string };

/** "לקחתי" (SPD-01): takes a lead nobody has, or marks your own as being handled. */
export function TakeLeadButton({ orgId, leadId, leadName, size = "md", className }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  return (
    <div className={cn("flex flex-col gap-2", size === "sm" && "max-w-48", className)}>
      <Button
        size={size}
        loading={pending}
        className={size === "sm" ? "min-h-11" : "w-full"}
        aria-label={`לקחתי את ${leadName}`}
        onClick={() =>
          startTransition(async () => {
            const answer = await takeLeadAction(orgId, leadId);
            setResult({ ok: answer.ok, message: answer.message ?? "" });
            // a refusal stays on screen to be read; a success redraws the page (owner, clock, button)
            if (answer.ok) router.refresh();
          })
        }
      >
        {pending ? null : <CheckIcon className="size-4.5" />}
        לקחתי
      </Button>
      {result?.ok ? <FormNotice message={result.message} /> : <FormError message={result?.message} />}
    </div>
  );
}
