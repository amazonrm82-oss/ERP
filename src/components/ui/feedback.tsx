import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** Error message for a form or an action. Announced immediately by screen readers. */
export function FormError({ message, className }: { message?: string | null; className?: string }) {
  if (!message) {
    return null;
  }
  return (
    <p role="alert" className={cn("rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger", className)}>
      {message}
    </p>
  );
}

/** Confirmation that something worked. */
export function FormNotice({ message, className }: { message?: string | null; className?: string }) {
  if (!message) {
    return null;
  }
  return (
    <p role="status" className={cn("rounded-md bg-success-soft px-3 py-2.5 text-sm text-success", className)}>
      {message}
    </p>
  );
}

type EmptyStateProps = { title: string; description?: string; action?: ReactNode; className?: string };

/** What a screen without data says: what belongs here and the first thing to do. */
export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center px-4 py-12 text-center", className)}>
      <p className="text-base font-semibold">{title}</p>
      {description ? <p className="mt-1 max-w-md text-[0.9375rem] text-ink-soft">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
