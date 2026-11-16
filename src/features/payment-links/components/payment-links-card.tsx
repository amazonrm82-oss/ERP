import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { agorotInput } from "@/features/deals/recurring";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, formatMoney, zoneDate } from "@/lib/format";

import { getPaymentLinksAccess, listPaymentLinks } from "../queries";
import { addDays, PAYMENT_LINK_DAYS_DEFAULT, PAYMENT_LINK_DAYS_MAX, PAYMENT_LINK_STATUS_LABELS, type PaymentLinkSource, type PaymentLinkStatus } from "../schema";
import { CancelPaymentLinkButton, CreatePaymentLinkButton } from "./payment-link-forms";

const STATUS_TONES: Record<PaymentLinkStatus, BadgeTone> = {
  pending: "accent",
  paid: "success",
  failed: "danger",
  expired: "neutral",
  cancelled: "warning",
};

type Props = {
  orgId: string;
  source: PaymentLinkSource;
  // what is open on the source (a quote's or order's total with VAT, a document's balance), or null for a free amount
  openAgorot: number | null;
  // false when the source is not open for payment now (a draft, a cancelled order, an expired quote): only the list shows
  canOpen: boolean;
};

/**
 * LNK-02: "קישורי תשלום" on a quote, an order or a contact: the links made for it, their amount, instalments, last day and
 * state, and "קישור תשלום" for whoever records payments (PAY-06). Hidden while there is no payment provider (owner (270)
 * (1) א: only the fake exists, never on the live site) or the plan lacks `payments` / `payment_links`. The payer pays on the
 * provider's page (LNK-03); with the fake provider there is no page, and the card says so.
 */
export async function PaymentLinksCard({ orgId, source, openAgorot, canOpen }: Props) {
  const access = await getPaymentLinksAccess(orgId);
  if (!access.provider || !access.inPlan) return null;
  const [links, context] = await Promise.all([listPaymentLinks(orgId, source), getOrgContext(orgId)]);
  const showCreate = access.canCreate && canOpen;
  if (links.length === 0 && !showCreate) return null;
  const today = zoneDate(new Date(), context.org.timeZone);
  const titleId = `payment-links-${source.id}`;
  const amountHint =
    openAgorot === null ? "סכום חופשי, כולל מע״מ." : `עד ${formatMoney(openAgorot)}, הסכום הפתוח כולל מע״מ. אפשר גם מקדמה או חלק מהסכום.`;
  return (
    <Card aria-labelledby={titleId}>
      <CardHeader
        id={titleId}
        title="קישורי תשלום"
        action={
          showCreate ? (
            <CreatePaymentLinkButton
              orgId={orgId}
              source={source}
              defaultAmount={openAgorot !== null && openAgorot > 0 ? agorotInput(openAgorot) : ""}
              defaultLastDay={addDays(today, PAYMENT_LINK_DAYS_DEFAULT)}
              today={today}
              lastDayMax={addDays(today, PAYMENT_LINK_DAYS_MAX)}
              amountHint={amountHint}
            />
          ) : null
        }
      />
      <CardBody>
        {access.provider === "fake" ? (
          <p className="mb-3 text-sm text-ink-soft" role="note">
            ספק סליקה לדוגמה: הקישורים כאן לבדיקה בלבד, אין דף תשלום ולא נגבה כסף.
          </p>
        ) : null}
        {links.length === 0 ? (
          <p className="text-sm text-ink-soft">עוד לא נוצרו קישורי תשלום.</p>
        ) : (
          <ul className="divide-y divide-line">
            {links.map((link) => {
              const label = formatMoney(link.amountAgorot);
              return (
                <li key={link.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      <bdi>{label}</bdi>
                      {link.maxInstallments > 1 ? <span className="text-sm text-ink-soft"> · עד {link.maxInstallments} תשלומים</span> : null}
                    </p>
                    <p className="text-sm text-ink-soft">
                      עד {formatDate(link.expiresOn)}
                      {link.title ? <> · <bdi>{link.title}</bdi></> : null}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={STATUS_TONES[link.status]}>{PAYMENT_LINK_STATUS_LABELS[link.status]}</Badge>
                    {link.status === "pending" && link.hostedUrl ? (
                      <a href={link.hostedUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-accent-strong underline-offset-4 hover:underline">
                        לדף התשלום
                        <span className="sr-only"> (נפתח בחלון חדש)</span>
                      </a>
                    ) : null}
                    {link.status === "pending" && access.canCreate ? <CancelPaymentLinkButton orgId={orgId} source={source} linkId={link.id} label={label} /> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
