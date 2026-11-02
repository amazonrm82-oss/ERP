import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { ListCard, ListCards } from "@/components/ui/table";
import { TextLink } from "@/components/ui/text-link";
import { customerStatusSettingsPath } from "@/features/customer-status/paths";
import { DORMANT_LIST_MAX, getCustomerStatusSettings, listDormantCustomers, type DormantCustomer } from "@/features/customer-status/queries";
import { monthsText } from "@/features/customer-status/status";
import { getOrgModules } from "@/features/modules/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, formatMoney } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "לקוחות רדומים" };

type Props = { params: Promise<{ orgId: string }> };

function DormantList({ label, rows, more, href }: { label: string; rows: DormantCustomer[]; more: boolean; href: (id: string) => string }) {
  return (
    <Card aria-label={label}>
      <CardHeader title={label} />
      <CardBody className="space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm text-ink-soft">אין כרגע.</p>
        ) : (
          <ListCards label={label}>
            {rows.map((row) => (
              <ListCard
                key={row.id}
                href={href(row.id)}
                title={row.name}
                subtitle={`קנייה אחרונה: ${formatDate(row.lastPurchaseOn)}`}
                meta={<span className="text-sm tabular-nums text-ink-soft">{formatMoney(row.value)}</span>}
              />
            ))}
          </ListCards>
        )}
        {more ? <p className="text-sm text-ink-soft">מוצגים {DORMANT_LIST_MAX} הראשונים, מי שלא קנה הכי הרבה זמן קודם.</p> : null}
      </CardBody>
    </Card>
  );
}

// RET-01: contacts and companies whose CON-11 status is dormant, longest without a purchase first. Owners and admins: the
// list reads the business-wide kept facts (public.dormant_customers answers {allowed: false} to anyone else).
export default async function DormantCustomersPage({ params }: Props) {
  const { orgId } = await params;
  await getOrgContext(orgId);
  const [settings, modules] = await Promise.all([getCustomerStatusSettings(orgId), getOrgModules(orgId)]);
  const [contacts, companies] = await Promise.all([
    listDormantCustomers(orgId, "contact"),
    modules.companies ? listDormantCustomers(orgId, "company") : Promise.resolve(null),
  ]);
  const header = (
    <PageHeader
      title="לקוחות רדומים"
      description={`לקוחות שלא קנו ${monthsText(settings.dormantMonths)} ויותר, ועוד לא ${monthsText(settings.formerMonths)}.`}
      back={{ href: paths.contacts(orgId), label: "חזרה לרשימה" }}
    />
  );
  if (!contacts.allowed) {
    return (
      <>
        {header}
        <EmptyState title="הרשימה זמינה לבעלים ולמנהלי מערכת" description="הסטטוס של כל לקוח מופיע בכרטיס שלו." compact />
      </>
    );
  }
  const companyRows = companies && companies.allowed ? companies : null;

  return (
    <>
      {header}
      <div className="space-y-5">
        {contacts.rows.length === 0 && (companyRows?.rows.length ?? 0) === 0 ? (
          <EmptyState title="אין כרגע לקוחות רדומים" description="כשלקוח לא קונה זמן מה, הוא יופיע כאן." compact />
        ) : null}
        <DormantList label="אנשי קשר" rows={contacts.rows} more={contacts.more} href={(id) => paths.contact(orgId, id)} />
        {companyRows ? <DormantList label="חברות" rows={companyRows.rows} more={companyRows.more} href={(id) => paths.company(orgId, id)} /> : null}
        <p className="text-sm text-ink-soft">
          קנייה היא עסקה שנסגרה בהצלחה או תשלום שנרשם. אפשר לשנות את מספר החודשים ב<TextLink href={customerStatusSettingsPath(orgId)}>הגדרות סטטוס לקוח</TextLink>, ולהוסיף
          אוטומציה &quot;איש קשר הפך ללקוח רדום&quot; שיוצרת משימה לחזור אליו.
        </p>
      </div>
    </>
  );
}
