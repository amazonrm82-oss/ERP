import Link from "next/link";
import type { ReactNode } from "react";

import { BackIcon } from "@/components/ui/icons";

type PageHeaderProps = {
  title: string;
  description?: string;
  // link back to the parent list
  back?: { href: string; label: string };
  actions?: ReactNode;
};

export function PageHeader({ title, description, back, actions }: PageHeaderProps) {
  return (
    <header className="mb-5 sm:mb-6">
      {back ? (
        <Link href={back.href} className="mb-2 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
          {/* "back" points against the reading direction: right in RTL */}
          <BackIcon className="size-4" />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold leading-tight text-balance break-words">{title}</h1>
          {description ? <p className="mt-1 text-md text-ink-soft">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
