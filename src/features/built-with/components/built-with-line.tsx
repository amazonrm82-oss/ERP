import { paths } from "@/lib/paths";
import { cn } from "@/lib/cn";

/**
 * The small "נבנה ב-Mexuz" line at the bottom of a customer-facing page (FLD-04):
 * the public lead form, and later the booking page. It links to the landing page
 * in a new tab. The page decides whether to render it (builtWithVisible).
 */
export function BuiltWithLine({ className }: { className?: string }) {
  return (
    <p className={cn("mt-6 text-center text-caption text-ink-soft", className)}>
      <a
        href={paths.landing}
        target="_blank"
        rel="noopener noreferrer"
        className="underline-offset-4 hover:text-ink hover:underline"
      >
        נבנה ב-<span dir="ltr">Mexuz</span>
        <span className="sr-only"> (נפתח בחלון חדש)</span>
      </a>
    </p>
  );
}
