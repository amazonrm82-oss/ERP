"use client";

import { useState, type ComponentProps } from "react";

import { FormError } from "@/components/ui/feedback";

import { GoalsGrid, type GoalsMessage } from "./goals-grid";

type Props = Omit<ComponentProps<typeof GoalsGrid>, "onMessage"> & {
  // changes when the saved goals change (after a copy), so the grid starts over from them
  gridKey: string;
};

/**
 * The grid and its messages. The messages live here, not in the grid: the grid is re-mounted
 * when the page refreshes after a copy, and the "copied" message has to survive that.
 */
export function GoalsPanel({ gridKey, ...grid }: Props) {
  const [message, setMessage] = useState<GoalsMessage>(null);
  return (
    <div className="space-y-4">
      {/* always on the page, so screen readers announce each message */}
      <div role="status" aria-live="polite">
        {message?.tone === "ok" ? <p className="rounded-md bg-success-soft px-3 py-2.5 text-sm text-success">{message.text}</p> : null}
      </div>
      {message?.tone === "error" ? <FormError message={message.text} /> : null}
      <GoalsGrid key={gridKey} {...grid} onMessage={setMessage} />
    </div>
  );
}
