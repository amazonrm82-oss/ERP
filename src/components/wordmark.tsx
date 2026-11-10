import Image from "next/image";

import logo from "@/assets/mexuz-logo.png";
import { APP_NAME } from "@/lib/app";
import { cn } from "@/lib/cn";

/**
 * The product logo (the owner's artwork, see scripts/make-icons.mjs). Height comes from className.
 * In dark mode it sits on a light plate (role logo-plate, transparent in light), because the logo's navy part vanishes on
 * a dark background (owner's answer 240 (ב), until a light SVG version exists). The plate is the image's own background
 * plus a ring of the same colour (a box-shadow), so the box and the layout are the same in both themes.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <Image
      src={logo}
      alt={APP_NAME}
      priority
      className={cn("h-6 w-auto max-w-none self-start rounded-sm bg-logo-plate ring-4 ring-logo-plate", className)}
      sizes="200px"
    />
  );
}
