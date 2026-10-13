import type { Metadata } from "next";
import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { ConversionMapForm } from "@/features/conversion-map/components/conversion-map-form";
import { getConversionMap } from "@/features/conversion-map/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "שדות בהמרת ליד" };

type Props = { params: Promise<{ orgId: string }> };

// LEAD-06: where each lead custom field goes when a lead becomes a contact and a deal. Owners and admins change it.
export default async function ConversionFieldsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const data = await getConversionMap(orgId);

  return (
    <div className="space-y-5">
      <Card aria-labelledby="conversion-fields-title">
        <CardHeader id="conversion-fields-title" title="שדות בהמרת ליד" />
        <CardBody className="space-y-2 text-md text-ink-soft">
          <p>
            כשליד הופך לאיש קשר ולעסקה, הערכים של השדות שהוספתם לליד עוברים איתו. כאן בוחרים לאיזה שדה של איש הקשר ושל העסקה
            עובר כל שדה, או שלא יעבור בכלל.
          </p>
          <p>
            &quot;העברה אוטומטית לפי שם&quot; מעבירה לשדה עם אותו שם ומאותו סוג. אפשר לבחור רק שדה מאותו סוג, וערך ששדה היעד לא מקבל לא עובר.
            השדות הקבועים (שם, טלפון, אימייל וכדומה) עוברים תמיד.
          </p>
          <p>שדה שבחרתם ידנית לשדה אחד של ליד לא יתמלא אוטומטית משדה אחר, גם כשהשדה שבחרתם ריק.</p>
          {!editable ? (
            <p>{isAdminRole(role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות את ההגדרה."}</p>
          ) : null}
        </CardBody>
      </Card>
      <Card aria-labelledby="conversion-fields-list-title">
        <CardHeader id="conversion-fields-list-title" title="שדות של ליד" />
        <CardBody>
          {data.leadFields.length === 0 ? (
            <EmptyState
              compact
              title="עוד אין שדות משלכם בליד"
              description="אחרי שתוסיפו שדה לליד, תוכלו לבחור כאן לאן הוא עובר בהמרה."
              action={
                isAdminRole(role) ? (
                  <Link href={paths.settingsFields(orgId)} className="font-medium text-accent underline underline-offset-4">
                    להוספת שדות
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <ConversionMapForm orgId={orgId} leadFields={data.leadFields} targets={data.targets} rows={data.rows} editable={editable} />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
