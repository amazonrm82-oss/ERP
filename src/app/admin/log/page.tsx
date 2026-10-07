import type { Metadata } from "next";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ACTION_LABELS } from "@/features/platform/labels";
import { listPlatformLog } from "@/features/platform/queries";
import { formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "יומן פלטפורמה" };

type Obj = Record<string, unknown>;

export default async function AdminLogPage() {
  const log = await listPlatformLog(null, 300);
  return (
    <>
      <PageHeader title="יומן פלטפורמה" description="כל פעולה של צוות הפלטפורמה. אי אפשר לשנות או למחוק את היומן." />
      <Card>
        {log.length === 0 ? (
          <p className="px-4 py-5 text-ink-soft sm:px-5">אין פעולות.</p>
        ) : (
          <ul className="divide-y divide-line">
            {log.map((l) => {
              const details = (l.details ?? {}) as Obj;
              return (
                <li key={String(l.id)} className="px-4 py-3 sm:px-5">
                  <p className="font-medium">
                    {ACTION_LABELS[String(l.action)] ?? String(l.action)}
                    {l.organization_id ? (
                      <>
                        {" · "}
                        <Link href={paths.adminOrg(String(l.organization_id))} className="underline underline-offset-4">
                          {String(l.organization_name ?? "ארגון")}
                        </Link>
                      </>
                    ) : null}
                  </p>
                  <p className="text-sm text-ink-soft">
                    {formatDateTime(String(l.created_at))} · <span dir="ltr">{String(l.actor_email ?? "")}</span>
                    {typeof details.reason === "string" ? ` · ${details.reason}` : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
