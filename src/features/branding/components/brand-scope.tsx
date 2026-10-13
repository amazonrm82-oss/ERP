import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { brandCss, brandScopeClass, isHexColor } from "../color";

/**
 * A part of a customer-facing page in the business's colour (FLD-04, DSN-17):
 * inside it, the accent roles (bg-accent, text-accent, focus ring…) take the
 * business's colour, corrected for contrast. Without a colour it is a plain
 * wrapper, and the design system's own accent stays. Never used in the app itself.
 */
export function BrandScope({ color, className, children }: { color: string | null; className?: string; children: ReactNode }) {
  const branded = isHexColor(color) ? color : null;
  return (
    <div className={cn(branded ? brandScopeClass(branded) : null, className)}>
      {branded ? <style>{brandCss(branded)}</style> : null}
      {children}
    </div>
  );
}
