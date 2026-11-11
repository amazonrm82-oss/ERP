import Image from "next/image";

import logoDark from "@/assets/mexuz-logo-dark.svg";
import logo from "@/assets/mexuz-logo.svg";
import { APP_NAME } from "@/lib/app";
import { cn } from "@/lib/cn";

/**
 * The product logo: two-colour SVGs traced from the owner's artwork (owner's answers 240 and 251). Height comes from
 * className. The light file shows by default and the dark one (its navy part in the dark ink) under an ancestor with
 * data-theme="dark", which is how dark mode is applied (globals.css). Both images share one box, so the layout is the
 * same in both themes. Both carry the name: the hidden one (display: none) is left out of the accessibility tree.
 */
export function Wordmark({ className }: { className?: string }) {
  const box = "h-6 w-auto max-w-none self-start";
  return (
    <>
      <Image
        src={logo}
        alt={APP_NAME}
        priority
        unoptimized
        className={cn(box, "[[data-theme=dark]_&]:hidden", className)}
      />
      <Image
        src={logoDark}
        alt={APP_NAME}
        priority
        unoptimized
        className={cn(box, "hidden [[data-theme=dark]_&]:inline", className)}
      />
    </>
  );
}
