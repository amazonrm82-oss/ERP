import type { Metadata } from "next";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getOrgContext } from "@/features/shell/queries";
import { MarkWhatsNewSeen } from "@/features/whats-new/components/mark-seen";
import { WHATS_NEW } from "@/features/whats-new/entries";
import { formatDate } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "מה חדש" };

// USR-12: what changed in the system lately, newest first. Opening the page clears the dot in the account menu.
export default async function WhatsNewPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);

  return (
    <>
      {/* a support session only reads: it does not mark anything for the customer's people */}
      {context.supportUntil ? null : <MarkWhatsNewSeen orgId={orgId} />}
      <PageHeader title="מה חדש" description="מה השתנה במערכת לאחרונה. חלק מהדברים תלויים בחבילה של העסק." />
      <Card>
        <ol className="divide-y divide-line">
          {WHATS_NEW.map((entry) => (
            <li key={`${entry.date}-${entry.title}`} className="space-y-1 px-4 py-4 sm:px-5">
              <p className="text-sm text-ink-soft">
                <time dateTime={entry.date}>{formatDate(entry.date)}</time>
              </p>
              <h2 className="font-semibold">{entry.title}</h2>
              <p className="text-md">{entry.body}</p>
            </li>
          ))}
        </ol>
      </Card>
      <p className="mt-5 text-md">
        משהו לא ברור, או חסר לכם משהו?{" "}
        <Link href={paths.support(orgId)} className="text-accent-strong underline underline-offset-4">
          פנייה לתמיכה
        </Link>
      </p>
    </>
  );
}
