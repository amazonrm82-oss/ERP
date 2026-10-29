import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { getOrgContext } from "@/features/shell/queries";
import { zoneDate } from "@/lib/format";
import { paths } from "@/lib/paths";

import { getCollectionAccess, getCustomerPromise } from "../queries";
import { PromiseButton } from "./promise-button";
import { PromiseLine } from "./promise-line";

type Props = {
  orgId: string;
  customer: { kind: "contact" | "company"; id: string };
  name: string;
  // a contact of a company pays as its company (PAY-02's customer): the promise is recorded on the company's card
  company?: { id: string; name: string | null } | null;
};

/**
 * COL-03 answer (8) ב: the customer's payment promise on the contact's or the company's card. Shown to whoever may open the
 * collection screen (BAL-01's recorders, with the collection, documents and payments keys); recorded, changed and removed under
 * the same rights as there (a writable business). The promise covers every open document of the customer (answer (6) ב); the
 * card shows how many, never which.
 */
export async function CustomerPromiseCard({ orgId, customer, name, company = null }: Props) {
  const access = await getCollectionAccess(orgId);
  if (!access.canOpen) return null;
  const titleId = `promise-${customer.id}`;
  const [promise, context] = await Promise.all([getCustomerPromise(orgId, customer), getOrgContext(orgId)]);
  const today = zoneDate(new Date(), context.org.timeZone);
  if (customer.kind === "contact" && company) {
    // a promise made before the contact joined the company still holds its documents: show it, so it can be changed or removed
    return (
      <Card aria-labelledby={titleId} className="print:hidden">
        <CardHeader
          id={titleId}
          title="הבטחת תשלום"
          action={
            access.canPromise && promise ? (
              <PromiseButton
                orgId={orgId}
                target={customer}
                label={name}
                back={{ kind: customer.kind, id: customer.id }}
                current={{ date: promise.date, note: promise.note }}
                today={today}
              />
            ) : null
          }
        />
        <CardBody className="space-y-2">
          {promise ? <PromiseLine date={promise.date} note={promise.note} today={today} customer covered={promise.covered} /> : null}
          <p className="text-sm text-ink-soft">
            איש הקשר משלם דרך החברה שלו, ולכן הבטחת תשלום נרשמת בכרטיס החברה:{" "}
            <Link href={paths.company(orgId, company.id)} className="text-accent-strong underline-offset-4 hover:underline">
              <bdi>{company.name ?? "החברה"}</bdi>
            </Link>
          </p>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader
        id={titleId}
        title="הבטחת תשלום"
        action={
          access.canPromise ? (
            <PromiseButton
              orgId={orgId}
              target={customer}
              label={name}
              back={{ kind: customer.kind, id: customer.id }}
              current={promise ? { date: promise.date, note: promise.note } : null}
              today={today}
            />
          ) : null
        }
      />
      <CardBody>
        {promise ? (
          <PromiseLine date={promise.date} note={promise.note} today={today} customer covered={promise.covered} />
        ) : (
          <p className="text-sm text-ink-soft">
            אין הבטחת תשלום. כשהלקוח מתחייב לשלם את החובות הפתוחים שלו עד תאריך, רושמים אותו כאן, ועד אז לא נשלחות לו תזכורות גבייה.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
