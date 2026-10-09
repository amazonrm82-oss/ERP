import type { ReactNode } from "react";

import { CheckIcon, LockIcon, SearchIcon } from "@/components/ui/icons";
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

export type EmptyKind = "start" | "search" | "locked" | "done";

type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  // what the screen holds (InboxIcon for leads); search, locked and done have their own
  icon?: ReactNode;
  // start: nothing here yet; search: nothing matches; locked: no access; done: all clear
  kind?: EmptyKind;
  // inside a card on a busy screen: smaller and without the big padding
  compact?: boolean;
  className?: string;
};

const art: Record<EmptyKind, string> = {
  start: "bg-accent-soft text-accent",
  search: "bg-canvas text-ink-soft",
  locked: "bg-canvas text-ink-soft",
  done: "bg-success-soft text-success",
};

const kindIcon: Record<Exclude<EmptyKind, "start">, ReactNode> = {
  search: <SearchIcon />,
  locked: <LockIcon />,
  done: <CheckIcon />,
};

/**
 * What a screen without data says (USR-05, DSN-10): a small drawing in one style
 * (an icon of the set in a soft circle), what belongs here, and the first thing to do.
 */
export function EmptyState({ title, description, action, icon, kind = "start", compact, className }: EmptyStateProps) {
  const drawing = kind === "start" ? icon : kindIcon[kind];
  return (
    <div className={cn("flex flex-col items-center text-center", compact ? "px-3 py-6" : "px-4 py-12", className)}>
      {drawing ? (
        <span
          aria-hidden="true"
          className={cn(
            "mb-4 flex items-center justify-center rounded-full [&>svg]:size-1/2",
            compact ? "mb-3 size-12" : "size-16",
            art[kind],
          )}
        >
          {drawing}
        </span>
      ) : null}
      <p className={cn("font-semibold", compact ? "text-md" : "text-base")}>{title}</p>
      {description ? <p className={cn("mt-1 max-w-md text-ink-soft", compact ? "text-sm" : "text-md")}>{description}</p> : null}
      {action ? <div className={compact ? "mt-3" : "mt-5"}>{action}</div> : null}
    </div>
  );
}
