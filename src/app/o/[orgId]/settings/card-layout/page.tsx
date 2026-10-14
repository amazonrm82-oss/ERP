import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { CardLayoutEditor } from "@/features/card-layout/components/card-layout-editor";
import { CARD_LAYOUT_TYPES, defaultLayout, isCardLayoutType, layoutCatalog, MORE_FIELDS_TITLE, type CardLayoutType } from "@/features/card-layout/layout";
import { cardLayoutSettingsPath } from "@/features/card-layout/paths";
import { getCardLayout } from "@/features/card-layout/queries";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { FIELD_OBJECT_LABELS } from "@/features/custom-fields/types";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { firstParam } from "@/lib/search";

export const metadata: Metadata = { title: "תצוגת כרטיס" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// FLD-08: the groups of fields on the details card of each record type. Owners and admins change them.
export default async function CardLayoutSettingsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const requested = firstParam((await searchParams).type);
  const type: CardLayoutType = isCardLayoutType(requested) ? requested : "lead";
  const editable = isAdminRole(role) && canWrite;
  const [layout, definitions] = await Promise.all([getCardLayout(orgId, type), listFieldDefinitions(orgId, type)]);
  const initial = layout ?? defaultLayout(type, definitions);

  return (
    <div className="space-y-5">
      <Card aria-labelledby="card-layout-about-title">
        <CardHeader id="card-layout-about-title" title="תצוגת כרטיס" />
        <CardBody className="space-y-2 text-md text-ink-soft">
          <p>
            כאן מסדרים את &quot;הפרטים&quot; בכרטיס של רשומה: קבוצות של שדות עם כותרת, בסדר שתבחרו, בטור אחד או בשני טורים. אפשר לסדר גם את
            השדות הקבועים, לא רק שדות שהוספתם.
          </p>
          <p>
            זה משנה רק את התצוגה בכרטיס. הטפסים לא משתנים, ושדות חובה (כמו השם) נשארים בהם. שדה שלא בקבוצה מופיע בסוף הכרטיס, בקבוצה &quot;
            {MORE_FIELDS_TITLE}&quot;, ושדה שמוסתר לפי תנאי נשאר מוסתר. כשיש קבוצה אחת בלבד, הכרטיס לא מציג את הכותרת שלה.
          </p>
          {!editable ? (
            <p>{isAdminRole(role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות את התצוגה."}</p>
          ) : null}
        </CardBody>
      </Card>
      <Tabs
        label="סוג רשומה"
        items={CARD_LAYOUT_TYPES.map((item) => ({ href: cardLayoutSettingsPath(orgId, item), label: FIELD_OBJECT_LABELS[item], current: item === type }))}
      />
      <CardLayoutEditor
        key={`${type}:${JSON.stringify(initial)}`}
        orgId={orgId}
        type={type}
        initial={initial}
        catalog={layoutCatalog(type, definitions)}
        editable={editable}
      />
    </div>
  );
}
