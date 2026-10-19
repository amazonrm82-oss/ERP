import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { TermsForm } from "@/features/terminology/components/terms-form";
import { getOrgTermKeys } from "@/features/terminology/queries";

export const metadata: Metadata = { title: "מונחים" };

type Props = { params: Promise<{ orgId: string }> };

// FLD-10 (owner, 18 October 2026): the business calls contacts, leads and deals by its own words, from a ready list.
export default async function TermsPage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const keys = await getOrgTermKeys(orgId);
  const editable = isAdminRole(context.role) && context.canWrite;
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-soft">
        איך העסק קורא לאנשים ולתהליכים שלו. המילים מופיעות בתפריט, בכותרות, בכפתורים ובמסכים הריקים. בוחרים מרשימה, כדי שכל
        המסכים יישארו נכונים בזכר ובנקבה, ביחיד וברבים.
      </p>
      {editable ? (
        <Card aria-labelledby="terms-title">
          <CardHeader id="terms-title" title="המונחים של העסק" />
          <CardBody>
            <TermsForm orgId={orgId} keys={keys} />
          </CardBody>
        </Card>
      ) : (
        <p className="text-sm text-ink-soft">{isAdminRole(context.role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות את המונחים."}</p>
      )}
    </div>
  );
}
