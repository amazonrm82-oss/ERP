import type { Metadata } from "next";
import type { ReactNode } from "react";

import { PublicShell } from "@/components/public-shell";

// public and useful to find (LND-11)
export const metadata: Metadata = { robots: { index: true, follow: true } };

export default function HelpLayout({ children }: { children: ReactNode }) {
  return <PublicShell>{children}</PublicShell>;
}
