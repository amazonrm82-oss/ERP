import type { Metadata } from "next";
import Link from "next/link";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { RoadmapVote } from "@/features/roadmap/components/vote-button";
import { groupByStatus, ROADMAP_STATUS_LABELS, type RoadmapStatus } from "@/features/roadmap/items";
import { getRoadmap } from "@/features/roadmap/queries";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "מפת דרכים" };

const TONES: Record<RoadmapStatus, BadgeTone> = { building: "accent", planned: "neutral", done: "success" };

// TRU-01: what is being built and what is planned, in the Mexuz team's own words. Owners and admins cast the business's
// one vote per item; everyone sees the count and whether the business voted, never which businesses did.
export default async function RoadmapPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await getOrgContext(orgId);
  const items = await getRoadmap(orgId);
  const groups = groupByStatus(items);
  const anyVote = items.some((item) => item.canVote);

  return (
    <>
      <PageHeader
        title="מפת דרכים"
        description={
          anyVote
            ? "מה אנחנו בונים עכשיו ומה מתוכנן. לכל עסק קול אחד בכל נושא, ובעלים ומנהלי מערכת מצביעים בשמו."
            : "מה אנחנו בונים עכשיו ומה מתוכנן. בעלים ומנהלי מערכת בעסק יכולים להצביע על מה שחשוב לכם."
        }
      />
      {groups.length === 0 ? (
        <Card>
          <p className="px-4 py-5 text-ink-soft sm:px-5">עוד אין פריטים במפת הדרכים.</p>
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.status} aria-labelledby={`roadmap-${group.status}`}>
              <h2 id={`roadmap-${group.status}`} className="mb-2 text-lg font-semibold">
                {ROADMAP_STATUS_LABELS[group.status]}
              </h2>
              <Card>
                <ul className="divide-y divide-line">
                  {group.items.map((item) => (
                    <li key={item.id} className="space-y-2 px-4 py-4 sm:px-5">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <h3 className="min-w-0 flex-1 font-semibold break-words">{item.title}</h3>
                        <Badge tone={TONES[item.status]}>{ROADMAP_STATUS_LABELS[item.status]}</Badge>
                      </div>
                      <p className="text-md break-words whitespace-pre-line">{item.description}</p>
                      <RoadmapVote
                        orgId={orgId}
                        itemId={item.id}
                        title={item.title}
                        votes={item.votes}
                        voted={item.voted}
                        canVote={item.canVote}
                      />
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      )}
      <p className="mt-5 text-md">
        חסר משהו שלא מופיע כאן?{" "}
        <Link href={paths.support(orgId)} className="text-accent-strong underline underline-offset-4">
          ספרו לנו בפנייה לתמיכה
        </Link>
        . הבקשה נשארת אצלנו ולא מוצגת לעסקים אחרים.
      </p>
    </>
  );
}
