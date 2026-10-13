import Link from "next/link";

import { CheckIcon } from "@/components/ui/icons";
import { DeviceStatus } from "@/features/notifications/components/device-warning";
import { TestNotificationButton } from "@/features/notifications/components/test-notification-button";
import { cn } from "@/lib/cn";

import { checklistProgress, type ChecklistItem } from "../checklist";

type Props = { orgId: string; items: ChecklistItem[]; labelledBy: string };

/** The setup checklist (USR-04): a progress bar with the percentage, and each item with a link to where it is done. */
export function SetupChecklist({ orgId, items, labelledBy }: Props) {
  const { done, total, percent } = checklistProgress(items);
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{`${percent}% הושלם`}</span>
        <span className="text-ink-soft">{`${done} מתוך ${total}`}</span>
      </div>
      <div
        role="progressbar"
        aria-labelledby={labelledBy}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}%, ${done} מתוך ${total}`}
        className="mb-4 h-2 overflow-hidden rounded-full bg-line-strong"
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
      <ul className="divide-y divide-line">
        {items.map((item) => (
          <li key={item.key} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <span
              aria-hidden="true"
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border",
                item.done ? "border-transparent bg-success-soft text-success" : "border-line-strong text-transparent",
              )}
            >
              <CheckIcon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              {item.done ? (
                <span className="block text-ink-soft line-through decoration-line-strong">{item.title}</span>
              ) : (
                <Link href={item.href} className="block font-medium text-accent-strong underline-offset-4 hover:underline">
                  {item.title}
                </Link>
              )}
              <span className="block text-sm text-ink-soft">{item.hint}</span>
              {/* GAP-01: whether this device gets notifications, and a test to prove it */}
              {item.key === "pushOn" ? (
                <div className="mt-2 space-y-2">
                  <DeviceStatus />
                  <TestNotificationButton orgId={orgId} />
                </div>
              ) : null}
            </div>
            <span className="sr-only">{item.done ? "בוצע" : "עוד לא"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
