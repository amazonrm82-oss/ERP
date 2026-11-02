import type { Metadata } from "next";

import { Detail, DetailList } from "@/components/detail-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextLink } from "@/components/ui/text-link";
import { CustomerStatusSettingsForm } from "@/features/customer-status/components/customer-status-settings-form";
import { dormantCustomersPath } from "@/features/customer-status/paths";
import { getCustomerStatusSettings } from "@/features/customer-status/queries";
import { monthsText } from "@/features/customer-status/status";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "סטטוס לקוח" };

type Props = { params: Promise<{ orgId: string }> };

// CON-11: after how many months without a purchase a customer counts as dormant, then former.
export default async function CustomerStatusSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const settings = await getCustomerStatusSettings(orgId);
  const editable = isAdminRole(role) && canWrite;

  const rules = (
    <Card aria-labelledby="customer-status-rules-title">
      <CardHeader id="customer-status-rules-title" title="איך זה נקבע" />
      <CardBody className="space-y-3 text-sm">
        <p>קנייה היא עסקה שנסגרה בהצלחה, או תשלום שנרשם או אושר (לא תשלום שבוטל, נכשל או הוחזר, ולא יתרת פתיחה). איש קשר או חברה בלי קנייה אינם לקוח, ואין להם סטטוס.</p>
        <p>
          הקנייה האחרונה של לקוח פעיל הייתה לפני פחות מ-{monthsText(settings.dormantMonths)}. לקוח רדום לא קנה {monthsText(settings.dormantMonths)} ויותר, ולקוח לשעבר
          לא קנה {monthsText(settings.formerMonths)} ויותר.
        </p>
        <p className="text-ink-soft">
          הערך המצטבר הוא סכום העסקאות שנסגרו בהצלחה, כפי שהן רשומות בעסקה (כמו בדוח ההכנסות). תשלום קובע רק את תאריך הקנייה האחרונה ולא נוסף לערך, כך
          ששום סכום לא נספר פעמיים. לחברה נספרים גם העסקאות והתשלומים של אנשי הקשר שלה שאין בהם חברה.
          בכרטיס, מי שלא רואה את כל העסקאות והתשלומים של הלקוח לא רואה סטטוס וערך.
        </p>
        {isAdminRole(role) ? (
          <p>
            <TextLink href={dormantCustomersPath(orgId)}>רשימת הלקוחות הרדומים</TextLink>
          </p>
        ) : (
          <p className="text-ink-soft">עמודות הסטטוס והערך ברשימות ורשימת הלקוחות הרדומים מוצגות לבעלים ולמנהלי מערכת. הסטטוס של כל לקוח מופיע בכרטיס שלו.</p>
        )}
      </CardBody>
    </Card>
  );

  if (editable) {
    return (
      <div className="space-y-5">
        <CustomerStatusSettingsForm orgId={orgId} dormantMonths={settings.dormantMonths} formerMonths={settings.formerMonths} />
        {rules}
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <Card aria-labelledby="customer-status-title">
        <CardHeader id="customer-status-title" title="סטטוס לקוח" />
        <CardBody>
          <DetailList>
            <Detail label="לקוח רדום אחרי" value={monthsText(settings.dormantMonths)} />
            <Detail label="לקוח לשעבר אחרי" value={monthsText(settings.formerMonths)} />
          </DetailList>
          <p className="mt-4 text-sm text-ink-soft">
            {isAdminRole(role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות."}
          </p>
        </CardBody>
      </Card>
      {rules}
    </div>
  );
}
