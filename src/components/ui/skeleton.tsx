import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** A grey block in the shape of what is loading. Hidden from screen readers; the wrapper says "טוען" once. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("block animate-pulse rounded-md bg-line", className)} />;
}

/** The one announcement for a loading screen, around its shape. */
function Loading({ label = "טוען…", children }: { label?: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

function HeaderSkeleton({ action = true }: { action?: boolean }) {
  return (
    <div className="mb-5 flex items-center justify-between gap-4 sm:mb-6">
      <span className="flex flex-col gap-2">
        <Skeleton className="h-7 w-36" />
        <Skeleton className="h-4 w-56 max-w-full" />
      </span>
      {action ? <Skeleton className="h-11 w-28" /> : null}
    </div>
  );
}

function RowsSkeleton({ rows }: { rows: number }) {
  return (
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
  );
}

/** The rows of a list, without a page header (inside a card or under filters). */
export function ListSkeleton({ rows = 5, label }: { rows?: number; label?: string }) {
  return (
    <Loading label={label}>
      <RowsSkeleton rows={rows} />
    </Loading>
  );
}

/** A list screen: title, search and filters, rows. */
export function ListPageSkeleton() {
  return (
    <Loading>
      <HeaderSkeleton />
      <div className="mb-4 flex gap-2">
        <Skeleton className="h-11 flex-1 sm:max-w-md" />
        <Skeleton className="h-11 w-24" />
      </div>
      <RowsSkeleton rows={6} />
    </Loading>
  );
}

/** A board: columns of cards that scroll sideways on a phone. */
export function BoardPageSkeleton() {
  return (
    <Loading>
      <HeaderSkeleton />
      <div className="flex gap-3 overflow-hidden">
        {[3, 2, 2, 1].map((cards, i) => (
          <div key={i} className="flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-canvas p-2">
            <Skeleton className="mx-1 my-1.5 h-4 w-24" />
            {Array.from({ length: cards }, (_, j) => (
              <div key={j} className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </Loading>
  );
}

/** A record card: name and actions, details beside the timeline on a computer. */
export function RecordPageSkeleton() {
  return (
    <Loading>
      <Skeleton className="mb-3 h-4 w-20" />
      <HeaderSkeleton />
      <div className="mb-5 flex gap-2">
        <Skeleton className="h-11 w-24" />
        <Skeleton className="h-11 w-24" />
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
          <Skeleton className="h-24 w-full" />
          {Array.from({ length: 4 }, (_, i) => (
            <span key={i} className="flex flex-col gap-2 py-1">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/4" />
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-32" />
            </span>
          ))}
        </div>
      </div>
    </Loading>
  );
}

/** "My day": the numbers and two cards. */
export function DashboardSkeleton() {
  return (
    <Loading>
      <HeaderSkeleton action={false} />
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex items-center justify-between rounded-lg border border-line bg-surface p-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-7 w-10" />
          </div>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <RowsSkeleton rows={3} />
        <RowsSkeleton rows={3} />
      </div>
    </Loading>
  );
}

/** A settings section: cards of form fields. */
export function FormPageSkeleton() {
  return (
    <Loading>
      <div className="flex flex-col gap-5">
        {[3, 2].map((fields, i) => (
          <div key={i} className="rounded-lg border border-line bg-surface">
            <div className="border-b border-line px-4 py-4">
              <Skeleton className="h-5 w-32" />
            </div>
            <div className="flex flex-col gap-4 p-4">
              {Array.from({ length: fields }, (_, j) => (
                <span key={j} className="flex flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-20" />
                  <Skeleton className="h-11 w-full" />
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Loading>
  );
}
