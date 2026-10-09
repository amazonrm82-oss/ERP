import { cn } from "@/lib/cn";

/** A grey block in the shape of what is loading. Hidden from screen readers; the page says "טוען" once. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("block animate-pulse rounded-md bg-line", className)} />;
}

/** The loading state of a list: a few rows in the shape of list cards. */
export function ListSkeleton({ rows = 5, label = "טוען…" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="flex flex-col gap-2">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex min-h-14 items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
            <span className="flex w-2/3 flex-col gap-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </span>
            <Skeleton className="h-5 w-14 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
