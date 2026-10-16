import type { Metadata } from "next";
import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { getOrgBranding } from "@/features/branding/queries";
import { QuoteDesignForm } from "@/features/quotes/components/quote-design-form";
import { QuoteDocument } from "@/features/quotes/components/quote-document";
import { getSampleDocumentData } from "@/features/quotes/design-server";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { documentSettingsPath } from "@/features/tax/paths";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "עיצוב הצעת מחיר" };

type Props = { params: Promise<{ orgId: string }> };

const linkClass = "text-accent-strong underline-offset-4 hover:underline";

// QUO-05: how quotes look to customers. Everyone sees it; owners and admins change it.
export default async function QuoteDesignPage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const [sample, branding] = await Promise.all([getSampleDocumentData(orgId, context.org.name), getOrgBranding(orgId)]);
  const editable = isAdminRole(context.role) && context.canWrite;
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-soft">
        כך נראית הצעת מחיר אצל הלקוח, בהדפסה ובהמשך גם בקובץ ובקישור. הלוגו נקבע ב
        <Link href={paths.settingsBusiness(orgId)} className={linkClass}>
          פרטי העסק
        </Link>
        , והשם הרשום, המספר והכתובת ב
        <Link href={documentSettingsPath(orgId)} className={linkClass}>
          מע&quot;מ ופרטים למסמכים
        </Link>
        .
      </p>
      {editable ? (
        <Card aria-labelledby="quote-design-title">
          <CardHeader id="quote-design-title" title="עיצוב" />
          <CardBody>
            <QuoteDesignForm orgId={orgId} design={sample.design} brandColor={branding.color} />
          </CardBody>
        </Card>
      ) : (
        <p className="text-sm text-ink-soft">{isAdminRole(context.role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות את העיצוב."}</p>
      )}
      <section aria-labelledby="quote-design-preview" className="space-y-2">
        <h2 id="quote-design-preview" className="text-base font-semibold">
          תצוגה מקדימה (הצעה לדוגמה, אחרי שמירה)
        </h2>
        <QuoteDocument data={sample} headingLevel={3} />
      </section>
    </div>
  );
}
