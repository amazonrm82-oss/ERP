import Image from "next/image";

import logo from "@/assets/mexuz-logo.png";
import { APP_NAME } from "@/lib/app";
import { cn } from "@/lib/cn";

/** The product logo (the owner's artwork, see scripts/make-icons.mjs). Height comes from className. */
export function Wordmark({ className }: { className?: string }) {
  return <Image src={logo} alt={APP_NAME} priority className={cn("h-6 w-auto max-w-none self-start", className)} sizes="200px" />;
}
