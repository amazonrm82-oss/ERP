"use client";

import { Button } from "@/components/ui/button";

/** Prints the page; the browser's print dialog also saves it as PDF. */
export function PrintButton() {
  return (
    <Button variant="secondary" className="print:hidden" onClick={() => window.print()}>
      הדפסה או שמירה כ-PDF
    </Button>
  );
}
