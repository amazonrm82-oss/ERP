import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { BlocklistAddForm } from "@/features/consent-blocklist/components/blocklist-add-form";
import { BlocklistSearch } from "@/features/consent-blocklist/components/blocklist-search";
import { BLOCKLIST_CHANNEL_LABELS, BLOCKLIST_CHANNELS } from "@/features/consent-blocklist/model";
import { getBlocklistSummary } from "@/features/consent-blocklist/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { formatNumber } from "@/lib/format";

export const metadata: Metadata = { title: "רשימת חסימה לדיוור" };

type Props = { params: Promise<{ orgId: string }> };

// CNS-06: phones and emails that never get marketing, even when they come in again. Owners and admins only; the
// addresses are kept as a hash, so the page searches one exact address and never lists them.
export default async function ConsentBlocklistPage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  if (!isAdminRole(context.role)) {
    return <p className="text-sm text-ink-soft">רק בעלים ומנהלי מערכת רואים את רשימת החסימה לדיוור.</p>;
  }
  const summary = await getBlocklistSummary(orgId);
  const editable = context.canWrite;
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-soft">
        טלפונים ואימיילים ברשימה לא יקבלו דיוור לעולם, גם אם ייובאו שוב, יירשמו בטופס או יסומנו כמסכימים. הכתובות נשמרות
        כקוד מגובב בלבד, בלי הכתובת עצמה, ולכן אי אפשר לראות את הרשימה: מחפשים כתובת מסוימת.
      </p>
      {!summary.key_present ? (
        <p className="text-sm text-warning">המפתח של העסק לקוד המגובב עדיין לא הוגדר. כתובות שנוספות עכשיו נשמרות עד שיוגדר, ואז הופכות לקוד מגובב בלבד.</p>
      ) : null}

      <Card aria-labelledby="blocklist-counts">
        <CardHeader id="blocklist-counts" title="ברשימה עכשיו" />
        <CardBody>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-ink-soft">סך הכל</dt>
              <dd className="text-lg text-ink">{formatNumber(summary.active)}</dd>
            </div>
            {BLOCKLIST_CHANNELS.map((channel) => (
              <div key={channel}>
                <dt className="text-xs text-ink-soft">{BLOCKLIST_CHANNEL_LABELS[channel]}</dt>
                <dd className="text-lg text-ink">{formatNumber(summary.by_channel[channel] ?? 0)}</dd>
              </div>
            ))}
            <div>
              <dt className="text-xs text-ink-soft">הוסרו מהרשימה</dt>
              <dd className="text-lg text-ink">{formatNumber(summary.removed)}</dd>
            </div>
          </dl>
          {summary.waiting_hash > 0 ? (
            <p className="mt-3 text-sm text-ink-soft">{formatNumber(summary.waiting_hash)} כתובות ממתינות להפיכה לקוד מגובב.</p>
          ) : null}
        </CardBody>
      </Card>

      <Card aria-labelledby="blocklist-search">
        <CardHeader id="blocklist-search" title="חיפוש כתובת" />
        <CardBody>
          <BlocklistSearch orgId={orgId} editable={editable} />
        </CardBody>
      </Card>

      {editable ? (
        <Card aria-labelledby="blocklist-add">
          <CardHeader id="blocklist-add" title="הוספה לרשימה" />
          <CardBody>
            <BlocklistAddForm orgId={orgId} />
          </CardBody>
        </Card>
      ) : (
        <p className="text-sm text-ink-soft">העסק במצב קריאה בלבד, ולכן אי אפשר לשנות את הרשימה כרגע.</p>
      )}
    </div>
  );
}
