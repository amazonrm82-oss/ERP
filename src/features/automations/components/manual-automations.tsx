"use client";

import { useState, useTransition } from "react";

import { buttonClasses } from "@/components/ui/button";
import { BoltIcon } from "@/components/ui/icons";
import { Popover } from "@/components/ui/popover";
import { ToastProvider, useToast } from "@/components/ui/toast";

import type { ManualEntity, ManualRule } from "../manual";
import { runManualAutomationAction } from "../manual-actions";

type Props = { orgId: string; entity: ManualEntity; recordId: string; rules: ManualRule[] };

/**
 * AUT-03: "הפעלת אוטומציה" on a record's card: the business's manual rules for this record type. The business layout has
 * no ToastProvider, so the button brings its own for the result message.
 */
export function ManualAutomations(props: Props) {
  if (props.rules.length === 0) return null;
  return (
    <ToastProvider>
      <ManualAutomationsMenu {...props} />
    </ToastProvider>
  );
}

function ManualAutomationsMenu({ orgId, entity, recordId, rules }: Props) {
  const toast = useToast();
  const [running, setRunning] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(rule: ManualRule, close: () => void) {
    setRunning(rule.id);
    startTransition(async () => {
      const answer = await runManualAutomationAction(orgId, rule.id, entity, recordId);
      setRunning(null);
      close();
      toast(answer.message ?? (answer.ok ? "האוטומציה רצה." : "לא הצלחנו להפעיל את האוטומציה."), answer.ok ? "success" : "error");
    });
  }

  return (
    <Popover
      label="הפעלת אוטומציה על הרשומה"
      triggerClassName={buttonClasses("secondary", "sm")}
      trigger={
        <>
          <BoltIcon className="size-4" />
          הפעלת אוטומציה
        </>
      }
    >
      {(close) => (
        <div className="p-2">
          <p className="px-2 pb-2 text-sm text-ink-soft">האוטומציה תרוץ עכשיו על הרשומה הזו, אם היא עומדת בתנאים.</p>
          <ul className="space-y-1">
            {rules.map((rule) => (
              <li key={rule.id}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(rule, close)}
                  className="flex min-h-11 w-full items-center rounded-md px-2 text-start text-md hover:bg-canvas disabled:opacity-60"
                >
                  {running === rule.id ? "מריצים…" : rule.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Popover>
  );
}
