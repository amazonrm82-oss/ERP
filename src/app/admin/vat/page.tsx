import type { Metadata } from "next";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateField } from "@/components/ui/date-picker";
import { TextField } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { addVatRateAction, removeVatRateAction, updateVatRateAction } from "@/features/platform/actions";
import { PlatformForm } from "@/features/platform/components/platform-form";
import { listAdminVatRates, platformReady } from "@/features/platform/queries";
import { VAT_RATE_STATUS_LABELS, vatPercentInput, withVatRateStatus, type VatRateStatus } from "@/features/platform/vat-rates";
import { vatRateLabel } from "@/features/tax/rates";
import { formatDate, zoneDate } from "@/lib/format";

export const metadata: Metadata = { title: 'שיעורי מע"מ' };

const TONES: Record<VatRateStatus, BadgeTone> = { in_force: "success", future: "accent", past: "neutral" };

/** The day after `day` (YYYY-MM-DD), the first day a new rate may start. */
function nextDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// ADM-01 (owner, 15 October 2026): the platform's VAT rates. Everyone on the platform staff sees them;
// only the platform owner adds a future rate or corrects or removes one that has not started.
export default async function AdminVatPage() {
  const me = await platformReady();
  if (!me) return null;
  const today = zoneDate(new Date());
  const rates = withVatRateStatus(await listAdminVatRates(), today);
  const canEdit = me.role === "owner";
  const firstDay = nextDay(today);

  return (
    <>
      <PageHeader
        title='שיעורי מע"מ'
        description="כל מסמך משתמש בשיעור של התאריך שלו. שיעור שהתאריך שלו כבר התחיל נעול: אי אפשר לשנות או להסיר אותו, רק להוסיף שיעור חדש מתאריך עתידי."
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card aria-labelledby="vat-list">
          <CardHeader id="vat-list" title="השיעורים" />
          {rates.length === 0 ? (
            <p className="px-4 py-5 text-ink-soft sm:px-5">אין שיעורים.</p>
          ) : (
            <ul className="divide-y divide-line">
              {rates.map((rate) => (
                <li key={rate.id} className="space-y-3 px-4 py-3 sm:px-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {vatRateLabel(rate.rateBp)} <span className="font-normal text-ink-soft">מ-{formatDate(rate.effectiveFrom)}</span>
                      </p>
                      {rate.note ? <p className="text-sm text-ink-soft break-words">{rate.note}</p> : null}
                    </div>
                    <Badge tone={TONES[rate.status]}>{VAT_RATE_STATUS_LABELS[rate.status]}</Badge>
                  </div>
                  {canEdit && rate.status === "future" ? (
                    <div className="flex flex-wrap items-start gap-2">
                      <details className="min-w-0 flex-1">
                        <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-accent-strong">תיקון</summary>
                        <PlatformForm action={updateVatRateAction.bind(null, rate.id)} submitLabel="שמירה" className="mt-2 space-y-4">
                          <DateField label="תאריך תחילה" name="effective_from" defaultValue={rate.effectiveFrom} min={firstDay} required />
                          <TextField label="שיעור (%)" name="rate" inputMode="decimal" dir="ltr" defaultValue={vatPercentInput(rate.rateBp)} required />
                          <TextField label="הערה" name="note" maxLength={200} defaultValue={rate.note ?? ""} />
                        </PlatformForm>
                      </details>
                      <ConfirmButton
                        title={`להסיר את השיעור ${vatRateLabel(rate.rateBp)} מ-${formatDate(rate.effectiveFrom)}?`}
                        description="השיעור עוד לא התחיל, ולכן אף מסמך לא משתמש בו. אחרי ההסרה ימשיך לחול השיעור הקודם. הפעולה נרשמת ביומן."
                        confirmLabel="הסרה"
                        action={removeVatRateAction.bind(null, rate.id)}
                      >
                        הסרה
                      </ConfirmButton>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
        {canEdit ? (
          <Card aria-labelledby="vat-add">
            <CardHeader id="vat-add" title="שיעור חדש" />
            <CardBody>
              <PlatformForm action={addVatRateAction} submitLabel="הוספה">
                <DateField label="תאריך תחילה" name="effective_from" min={firstDay} required hint="רק תאריך עתידי, מחר והלאה." />
                <TextField label="שיעור (%)" name="rate" inputMode="decimal" dir="ltr" required hint="למשל 18 או 17.5" />
                <TextField label="הערה" name="note" maxLength={200} hint="לא חובה. למשל: לפי חוק ההסדרים" />
              </PlatformForm>
            </CardBody>
          </Card>
        ) : (
          <p className="text-md text-ink-soft">רק בעלי הפלטפורמה מוסיפים או מתקנים שיעורים.</p>
        )}
      </div>
    </>
  );
}
