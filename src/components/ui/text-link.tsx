import Link from "next/link";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

/** The one link style inside text (FXU-14): the accent colour, underlined, so it is not told by colour alone. */
export function TextLink({ className, ...props }: ComponentProps<typeof Link>) {
  return <Link className={cn("text-accent underline underline-offset-4 hover:text-accent-strong", className)} {...props} />;
}
