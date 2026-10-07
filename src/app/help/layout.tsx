import type { ReactNode } from "react";

import { PublicShell } from "@/components/public-shell";

export default function HelpLayout({ children }: { children: ReactNode }) {
  return <PublicShell>{children}</PublicShell>;
}
