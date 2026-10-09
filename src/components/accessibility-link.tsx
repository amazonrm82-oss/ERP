import Link from "next/link";

import { cn } from "@/lib/cn";
import { paths } from "@/lib/paths";

/**
 * The accessibility statement, linked from the bottom of every public page
 * (FXA-06). Inside a form embedded in another site it opens in a new tab.
 */
export function AccessibilityLink({ newTab, className }: { newTab?: boolean; className?: string }) {
  return (
    <p className={cn("mt-8 text-center text-sm text-ink-soft", className)}>
      <Link
        href={paths.legal("accessibility")}
        target={newTab ? "_blank" : undefined}
        rel={newTab ? "noopener noreferrer" : undefined}
        className="underline underline-offset-4 hover:text-ink"
      >
        הצהרת נגישות
        {newTab ? <span className="sr-only"> (נפתח בחלון חדש)</span> : null}
      </Link>
    </p>
  );
}
