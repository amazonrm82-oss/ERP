"use client";

import { Button } from "@/components/ui/button";

/**
 * GAP-11: prints the page (the browser's dialog also saves it as PDF). The print layout comes
 * from `PrintHeader` on the same page; the button itself is not printed.
 */
export function PrintButton({ label = "הדפסה" }: { label?: string }) {
  return (
    <Button variant="secondary" size="sm" className="print:hidden" onClick={() => window.print()}>
      {label}
    </Button>
  );
}
