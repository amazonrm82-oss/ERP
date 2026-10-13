import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatDate } from "@/lib/format";

import { vatRateAt, vatRateLabel, type VatRate } from "../rates";

type Props = { rates: VatRate[]; today: string; charges: boolean | null };

/** The VAT rate of today and its history (TAX-03). Set by the platform, the same for every business. */
export function VatRatesCard({ rates, today, charges }: Props) {
  const current = vatRateAt(rates, today);
  // noon UTC is the same calendar day in Israel
  const day = (iso: string) => formatDate(`${iso}T12:00:00Z`);
  return (
    <Card aria-labelledby="vat-rate-title">
      <CardHeader id="vat-rate-title" title='שיעור המע"מ' />
      <CardBody className="space-y-3">
        <p className="text-md">
          {current === null ? 'אין שיעור מע"מ ידוע להיום.' : `השיעור היום: ${vatRateLabel(current)}`}
        </p>
        <p className="text-sm text-ink-soft">
          {charges === false
            ? 'העסק לא גובה מע"מ, ולכן אין מע"מ במסמכים שלו.'
            : 'השיעור נקבע בחוק ומתעדכן במערכת. כל מסמך מחושב לפי השיעור שהיה בתוקף בתאריך שלו.'}
        </p>
        {rates.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {[...rates].reverse().map((rate) => (
              <li key={rate.effectiveFrom}>
                {vatRateLabel(rate.rateBp)} מ-{day(rate.effectiveFrom)}
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}
