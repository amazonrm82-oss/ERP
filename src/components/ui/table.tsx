import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * A data table. It scrolls sideways inside its own box, never the page (360px).
 * The caption names the table for screen readers; hide it when a heading above says the same.
 */
export function Table({ caption, hideCaption, className, children }: { caption: string; hideCaption?: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={cn("overflow-x-auto rounded-lg border border-line bg-surface", className)}>
      <table className="w-full border-collapse text-md">
        <caption className={cn("px-4 py-3 text-start font-semibold", hideCaption && "sr-only")}>{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function Th({ className, scope = "col", ...props }: ComponentProps<"th">) {
  return (
    <th
      scope={scope}
      className={cn("border-b border-line bg-canvas px-4 py-2.5 text-start text-sm font-medium whitespace-nowrap text-ink-soft", className)}
      {...props}
    />
  );
}

export function Td({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("border-b border-line px-4 py-3 align-middle", className)} {...props} />;
}

export function Tr({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("last:[&>td]:border-b-0 hover:bg-canvas", className)} {...props} />;
}

type ListCardProps = {
  href: string;
  title: string;
  // a line under the title: company, phone, amount
  subtitle?: ReactNode;
  // badges or a date on the far side
  meta?: ReactNode;
  className?: string;
};

/** One row of a list as a card: what a phone shows instead of a wide table. */
export function ListCard({ href, title, subtitle, meta, className }: ListCardProps) {
  return (
    <li>
      <Link href={href} className={cn("flex min-h-14 items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3 hover:bg-canvas", className)}>
        <span className="min-w-0">
          <span className="block truncate font-medium text-ink">{title}</span>
          {subtitle ? <span className="block truncate text-sm text-ink-soft">{subtitle}</span> : null}
        </span>
        {meta ? <span className="flex shrink-0 items-center gap-2">{meta}</span> : null}
      </Link>
    </li>
  );
}

/** The list that holds ListCards (each one is an <li>). */
export function ListCards({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <ul aria-label={label} className={cn("flex flex-col gap-2", className)}>
      {children}
    </ul>
  );
}
