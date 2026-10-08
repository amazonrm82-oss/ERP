import "@fontsource-variable/assistant";
import "@fontsource-variable/rubik";

import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";

import { PageHeader } from "@/components/ui/page-header";
import { SCREENS } from "@/features/design-preview/components/screens";
import { DIRECTIONS, directionStyle, findDirection, textPairs } from "@/features/design-preview/directions";
import { platformReady } from "@/features/platform/queries";
import { cn } from "@/lib/cn";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "שלושה כיוונים עיצוביים" };

type SearchParams = Promise<{ d?: string; v?: string }>;

// DSN-02: the owner picks a design direction here, on the phone first. Only
// platform staff reach /admin (the layout answers 404 to everyone else).
export default async function DesignPreviewPage({ searchParams }: { searchParams: SearchParams }) {
  if (!(await platformReady())) return null;
  const params = await searchParams;
  const direction = findDirection(params.d);
  const desktop = params.v === "desktop";
  const href = (d: string, v: string) => `${paths.adminDesign}?d=${d}&v=${v}`;
  const weakest = Math.min(...textPairs(direction).map((p) => p.ratio));

  return (
    <>
      <PageHeader title="שלושה כיוונים עיצוביים" description="אותם מסכים בשלושה סגנונות. כדאי לבחור על הטלפון, כי שם הלקוחות יעבדו." />

      <nav aria-label="כיוון" className="mb-3 flex flex-wrap gap-2">
        {DIRECTIONS.map((d, i) => (
          <Link
            key={d.key}
            href={href(d.key, desktop ? "desktop" : "phone")}
            aria-current={d.key === direction.key ? "page" : undefined}
            className={cn(
              "min-h-11 rounded-md border px-4 py-2 text-[0.9375rem] font-medium",
              d.key === direction.key ? "border-accent bg-accent text-white" : "border-line-strong bg-surface hover:bg-canvas",
            )}
          >
            {["א", "ב", "ג"][i]}. {d.name}
          </Link>
        ))}
      </nav>
      <nav aria-label="תצוגה" className="mb-4 flex gap-2 text-[0.9375rem]">
        {[
          ["phone", "טלפון"],
          ["desktop", "מחשב"],
        ].map(([v, label]) => (
          <Link
            key={v}
            href={href(direction.key, v)}
            aria-current={(v === "desktop") === desktop ? "page" : undefined}
            className={cn(
              "min-h-10 rounded-md px-3 py-2",
              (v === "desktop") === desktop ? "bg-accent-soft font-medium text-accent-strong" : "text-ink-soft hover:bg-canvas",
            )}
          >
            {label}
          </Link>
        ))}
      </nav>

      <section className="mb-6 rounded-lg border border-line bg-surface p-4">
        <h2 className="font-semibold">{direction.name}</h2>
        <p className="mt-1 text-ink-soft">{direction.summary}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-ink-soft">גופן</dt>
            <dd>{direction.fontLabel}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">פינות</dt>
            <dd>{direction.radius.md} פיקסלים</dd>
          </div>
          <div>
            <dt className="text-ink-soft">צפיפות</dt>
            <dd>{direction.densityLabel}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">אייקונים</dt>
            <dd>{direction.iconLabel}</dd>
          </div>
        </dl>
        <p className="mt-2 text-sm text-ink-soft">
          הניגודיות הנמוכה ביותר בין טקסט לרקע: <span className="tabular-nums">{weakest.toFixed(1)}:1</span> (הסף הוא 4.5:1).
        </p>
        <ul className="mt-3 flex gap-1.5" aria-label="הצבעים">
          {[direction.colors.accent, direction.colors.accentStrong, direction.colors.accentSoft, direction.colors.canvas, direction.colors.ink, direction.colors.chrome, direction.colors.success, direction.colors.warning, direction.colors.danger].map((c, i) => (
            <li key={`${c}-${i}`} className="size-7 rounded-md border border-line" style={{ background: c }} title={c} />
          ))}
        </ul>
      </section>

      <div className={cn("grid gap-6", desktop ? "grid-cols-1" : "justify-items-center sm:grid-cols-2 xl:grid-cols-3")}>
        {SCREENS.map(({ key, label, Screen }) => (
          <figure key={key} className="min-w-0">
            <figcaption className="mb-2 text-sm font-medium text-ink-soft">{label}</figcaption>
            <div className={desktop ? "overflow-hidden rounded-lg border border-line-strong [zoom:0.27] sm:[zoom:0.5] lg:[zoom:0.8]" : ""}>
              <div
                style={directionStyle(direction) as CSSProperties}
                className={cn(
                  "@container overflow-hidden text-[0.9375rem] leading-normal [&_svg]:[stroke-linecap:var(--icon-caps)] [&_svg]:[stroke-width:var(--icon-stroke)]",
                  desktop ? "h-[760px] w-[1280px]" : "h-[700px] w-[360px] rounded-[28px] border-8 border-ink shadow-lg",
                )}
              >
                <Screen />
              </div>
            </div>
          </figure>
        ))}
      </div>
    </>
  );
}
