import type { Metadata } from "next";

import { Detail, DetailList } from "@/components/detail-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { NumberSeriesForm } from "@/features/numbering/components/number-series-form";
import { getNumberSeries } from "@/features/numbering/queries";
import { displayNumber, nextNumber, NUMBERING_NOTE, SERIES_LABELS, usedText } from "@/features/numbering/series";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "מספור הצעות והזמנות" };

type Props = { params: Promise<{ orgId: string }> };

// QUO-03: the prefix and the start of the running numbers of quotes and orders.
export default async function NumberingSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const series = await getNumberSeries(orgId);
  const editable = isAdminRole(role) && canWrite;

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-soft">{NUMBERING_NOTE}</p>
      {editable
        ? series.map((item) => <NumberSeriesForm key={item.kind} orgId={orgId} series={item} />)
        : series.map((item) => (
            <Card key={item.kind} aria-labelledby={`numbering-${item.kind}-title`}>
              <CardHeader id={`numbering-${item.kind}-title`} title={SERIES_LABELS[item.kind].title} />
              <CardBody className="space-y-3">
                <DetailList>
                  <Detail label="קידומת" value={item.prefix || "בלי קידומת"} ltr={Boolean(item.prefix)} />
                  <Detail label="מספר התחלתי" value={String(item.startNumber)} ltr />
                  <Detail label="המסמך הבא יקבל" value={displayNumber(item.prefix, nextNumber(item))} ltr />
                </DetailList>
                <p className="text-sm text-ink-soft">{usedText(item)}</p>
              </CardBody>
            </Card>
          ))}
      {editable ? null : (
        <p className="text-sm text-ink-soft">
          {isAdminRole(role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות את המספור."}
        </p>
      )}
    </div>
  );
}
