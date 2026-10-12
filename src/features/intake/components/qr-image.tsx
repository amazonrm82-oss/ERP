import type { Ref } from "react";

import { cn } from "@/lib/cn";
import { qrPath, type QrCode } from "@/lib/qr";

/**
 * A QR code drawn with the design system (CAP-03): dark modules in the brand
 * navy on paper white, the same in both themes so every camera reads it.
 * The quiet zone (4 modules) is part of the drawing.
 */
export function QrImage({ code, label, className, ref }: { code: QrCode; label: string; className?: string; ref?: Ref<SVGSVGElement> }) {
  const dim = code.size + 8;
  return (
    <svg
      ref={ref}
      role="img"
      aria-label={label}
      viewBox={`0 0 ${dim} ${dim}`}
      shapeRendering="crispEdges"
      className={cn("block bg-paper text-brand", className)}
    >
      <path d={qrPath(code)} fill="currentColor" />
    </svg>
  );
}
