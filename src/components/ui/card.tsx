import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/cn";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("rounded-lg border border-line bg-surface", className)} {...props} />;
}

type CardHeaderProps = { title: string; action?: ReactNode; id?: string };

export function CardHeader({ title, action, id }: CardHeaderProps) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-3 border-b border-line px-4 py-2 sm:px-5">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {action}
    </div>
  );
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-4 sm:p-5", className)} {...props} />;
}
