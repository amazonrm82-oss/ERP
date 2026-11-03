import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Meter } from "@/components/ui/chart";
import { formatDate, zoneDate } from "@/lib/format";

import { PUNCH_STATE_LABELS, PUNCH_STATE_TONE, remainingText } from "../balance";
import { getPunchAccess, listContactPayments, listContactPunchCards, listPunchProducts } from "../queries";
import {
  ActivatePunchCardButton,
  CancelPunchCardButton,
  OpenPunchCardButton,
  ReturnPunchUseButton,
  TransferPunchCardButton,
} from "./punch-card-forms";

/**
 * PKG-01, PKG-02: the contact's punch cards with their balance. Shown to whoever reads the contact while the plan has
 * the key, or while the contact holds a card (a card sold before a downgrade keeps showing). Sellers open cards;
 * owners/admins activate by hand, cancel and transfer; owners, admins and managers give a used entry back.
 */
export async function PunchCardsCard({ orgId, contactId, timeZone }: { orgId: string; contactId: string; timeZone: string }) {
  const access = await getPunchAccess(orgId);
  const cards = await listContactPunchCards(orgId, contactId, timeZone);
  if (!access.inPlan && cards.length === 0) return null;
  const needsChoices = access.inPlan && (access.canSell || access.isAdmin);
  const [products, payments] = needsChoices
    ? await Promise.all([listPunchProducts(orgId), access.canSell ? listContactPayments(orgId, contactId) : Promise.resolve([])])
    : [[], []];
  const titleId = `punch-cards-${contactId}`;
  const today = zoneDate(new Date(), timeZone);
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader
        id={titleId}
        title={cards.length > 0 ? `כרטיסיות (${cards.length})` : "כרטיסיות"}
        action={
          access.canSell && products.length > 0 ? (
            <OpenPunchCardButton orgId={orgId} contactId={contactId} products={products} payments={payments} isAdmin={access.isAdmin} />
          ) : null
        }
      />
      <CardBody className="space-y-4">
        {cards.length === 0 ? (
          <p className="text-sm text-ink-soft">
            {access.canSell && products.length === 0 ? "אין עדיין כרטיסיות בקטלוג. מוסיפים מוצר מסוג \"כרטיסייה\" בעמוד המוצרים." : "אין כרטיסיות לאיש הקשר."}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {cards.map((card) => (
              <li key={card.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0 font-medium break-words">{card.name}</span>
                  <span className="flex flex-wrap gap-1.5">
                    <Badge tone={PUNCH_STATE_TONE[card.balance.state]}>{PUNCH_STATE_LABELS[card.balance.state]}</Badge>
                    {card.balance.low ? <Badge tone="warning">נשארו מעט</Badge> : null}
                  </span>
                </div>
                <Meter value={card.balance.remaining} max={card.balance.total} label={remainingText(card.balance)} />
                <p className="text-sm text-ink-soft">
                  {remainingText(card.balance)}
                  {card.expiresOn ? ` · ${card.balance.state === "expired" ? "פג תוקף ב-" : "בתוקף עד "}${formatDate(card.expiresOn)}` : ""}
                  {card.balance.state === "expired" && card.balance.remaining > 0 ? " · היתרה לא ניתנת לניצול" : ""}
                </p>
                {card.activatedText ? <p className="text-sm text-ink-soft">{card.activatedText}</p> : null}
                {card.paymentVoid ? (
                  <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
                    התשלום של הכרטיסייה בוטל. הכרטיסייה עדיין פעילה: בעלים או מנהל מערכת מחליטים אם לבטל אותה.
                  </p>
                ) : null}
                {card.cancelReason ? (
                  <p className="text-sm break-words text-ink-soft">
                    סיבת הביטול: <bdi>{card.cancelReason}</bdi>
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {card.status === "pending" && (access.canSell || access.isAdmin) && access.inPlan ? (
                    <ActivatePunchCardButton
                      orgId={orgId}
                      contactId={contactId}
                      cardId={card.id}
                      payments={payments}
                      isAdmin={access.isAdmin}
                      canSell={access.canSell}
                    />
                  ) : null}
                  {card.status !== "cancelled" && access.isAdmin ? (
                    <>
                      {access.inPlan ? <TransferPunchCardButton orgId={orgId} contactId={contactId} cardId={card.id} /> : null}
                      <CancelPunchCardButton
                        orgId={orgId}
                        contactId={contactId}
                        cardId={card.id}
                        remaining={card.balance.remaining}
                        refund={card.refund}
                        today={today}
                      />
                    </>
                  ) : null}
                </div>
                {card.uses.length > 0 ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-ink-soft">כניסות שנוצלו ({card.uses.filter((u) => !u.returned).length})</summary>
                    <ul className="mt-2 space-y-2">
                      {card.uses.map((use) => (
                        <li key={use.id} className="space-y-1">
                          <p className={use.returned ? "text-ink-soft line-through" : undefined}>
                            {formatDate(use.usedOn)}
                            {use.meetingTitle ? ` · ${use.meetingTitle}` : ""}
                          </p>
                          {use.returnText ? <p className="break-words text-ink-soft">{use.returnText}</p> : null}
                          {!use.returned && access.canReturn ? <ReturnPunchUseButton orgId={orgId} contactId={contactId} useId={use.id} /> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
