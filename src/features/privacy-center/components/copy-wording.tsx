"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/** PRK-04: one wording with its copy button; the text stays selectable when copying is blocked. */
export function CopyWording({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="space-y-2">
      <p className="rounded-md border border-line bg-canvas p-3 text-md leading-relaxed select-all">{text}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={copy}>
          העתקה
          <span className="sr-only">: {label}</span>
        </Button>
        <p role="status" className="text-sm text-ink-soft">
          {state === "copied" ? "הועתק." : state === "failed" ? "ההעתקה לא הצליחה. סמנו את הטקסט והעתיקו ידנית." : ""}
        </p>
      </div>
    </div>
  );
}
