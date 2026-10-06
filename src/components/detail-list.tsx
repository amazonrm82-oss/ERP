import type { ReactNode } from "react";

/** Label/value pairs of a record card. Empty values are shown as a dash so the layout stays stable. */
export function DetailList({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-3 text-[0.9375rem]">{children}</dl>;
}

type DetailProps = {
  label: string;
  value: ReactNode;
  // phone numbers, emails and other Latin values keep their left-to-right order
  ltr?: boolean;
};

export function Detail({ label, value, ltr }: DetailProps) {
  const isEmpty = value === null || value === undefined || value === "";
  return (
    <>
      <dt className="text-ink-soft">{label}</dt>
      <dd className="min-w-0 break-words">
        {isEmpty ? (
          <>
            <span aria-hidden="true" className="text-ink-soft">
              –
            </span>
            <span className="sr-only">לא הוזן</span>
          </>
        ) : ltr ? (
          <span dir="ltr" className="inline-block max-w-full break-all">
            {value}
          </span>
        ) : (
          value
        )}
      </dd>
    </>
  );
}
