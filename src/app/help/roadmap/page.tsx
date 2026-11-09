import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { groupByStatus, ROADMAP_STATUS_LABELS } from "@/features/roadmap/items";
import { PUBLIC_ROADMAP_ITEMS, PUBLIC_ROADMAP_NOTE } from "@/features/roadmap/public-items";
import { APP_NAME } from "@/lib/app";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "מפת דרכים", description: `מה בבנייה ומה מתוכנן ב-${APP_NAME}` };

// TRU-01: the public roadmap, published with the owner's approval (answer 192): titles and status only, no dates.
// Static, from the code (src/features/roadmap/public-items.ts): it reads nothing from the database and takes no visitor
// input. Voting happens inside the system, for signed-in businesses.
export default function PublicRoadmapPage() {
  const groups = groupByStatus(PUBLIC_ROADMAP_ITEMS);
  return (
    <>
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-3xl font-semibold">מפת דרכים</h1>
        <p className="mt-2 mb-8 text-lg text-ink-soft">מה אנחנו בונים עכשיו, ומה מתוכנן אחר כך.</p>
      </div>
      <div className="mx-auto max-w-2xl space-y-8">
        {groups.map((group) => (
          <section key={group.status} aria-labelledby={`public-roadmap-${group.status}`}>
            <h2 id={`public-roadmap-${group.status}`} className="border-b border-line pb-2 text-lg font-semibold">
              {ROADMAP_STATUS_LABELS[group.status]}
            </h2>
            <ul className="divide-y divide-line">
              {group.items.map((item) => (
                <li key={item.key} className="py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="min-w-0 flex-1 font-semibold">{item.title}</h3>
                    <Badge tone={item.status === "building" ? "accent" : "neutral"}>{ROADMAP_STATUS_LABELS[item.status]}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="text-md text-ink-soft">{PUBLIC_ROADMAP_NOTE}.</p>
        <p className="text-md">
          לקוחות {APP_NAME} מצביעים על מה שחשוב להם מתוך המערכת, בעמוד &quot;מפת דרכים&quot;.{" "}
          <Link href={paths.help} className="text-accent-strong underline underline-offset-4">
            חזרה למרכז העזרה
          </Link>
        </p>
      </div>
    </>
  );
}
