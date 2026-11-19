import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SupportContact } from "@/features/support/components/support-contact";
import { formatDateTime, formatMoney, formatNumber } from "@/lib/format";

import { SMS_MOVEMENT_LABELS, SMS_OFFER_TEXT, SMS_PACK_NOTE, SMS_PACKS, smsBalanceLine, type SmsBalance } from "../packs";

/** SMS-06: the prepaid SMS balance, its last movements and the offer to buy (owners and admins). */
export function SmsBalanceCard({ balance, id = "sms-balance-title" }: { balance: SmsBalance; id?: string }) {
  const low = balance.loaded && balance.lowAt !== null && balance.balance <= balance.lowAt;
  return (
    <Card aria-labelledby={id}>
      <CardHeader id={id} title="יתרת SMS" />
      <CardBody className="space-y-4">
        <p className="flex flex-wrap items-center gap-2 text-md">
          <span className="text-lead font-semibold tabular-nums">{formatNumber(balance.balance)}</span>
          <span>מקטעים</span>
          {!balance.loaded ? <Badge tone="neutral">כבוי</Badge> : low ? <Badge tone="danger">יתרה נמוכה</Badge> : <Badge tone="success">פעיל</Badge>}
        </p>
        <p className="text-md">{smsBalanceLine(balance)}</p>
        {balance.channel === "off_plan" ? <p className="text-sm text-ink-soft">שליחת SMS אינה כלולה בחבילה הנוכחית.</p> : null}

        <div className="space-y-2">
          <p className="text-md">{SMS_OFFER_TEXT}</p>
          <ul className="grid gap-2 sm:grid-cols-3" aria-label="חבילות SMS">
            {SMS_PACKS.map((pack) => (
              <li key={pack.segments} className="rounded-md border border-line px-3 py-2">
                <span className="block font-medium">{`${formatNumber(pack.segments)} מקטעים`}</span>
                <span className="block text-sm text-ink-soft">{formatMoney(pack.priceAgorot)}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-ink-soft">{SMS_PACK_NOTE}</p>
          <SupportContact />
        </div>

        {balance.movements.length > 0 ? (
          <div>
            <h3 className="mb-2 text-md font-semibold">תנועות אחרונות</h3>
            <ul className="divide-y divide-line text-sm">
              {balance.movements.map((m, i) => (
                <li key={`${m.at}-${i}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  <span>
                    {SMS_MOVEMENT_LABELS[m.kind]}
                    {m.pack ? ` (${formatNumber(m.pack)})` : ""}
                    {m.kind === "verification" && m.messageSegments ? ` (${formatNumber(m.messageSegments)} מקטעים)` : ""}
                    <span className="ms-2 text-ink-soft">{formatDateTime(m.at)}</span>
                  </span>
                  <span className="tabular-nums">
                    <bdi dir="ltr">{m.segments > 0 ? `+${formatNumber(m.segments)}` : formatNumber(m.segments)}</bdi>
                    <span className="ms-2 text-ink-soft">{`יתרה: ${formatNumber(m.balanceAfter)}`}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
