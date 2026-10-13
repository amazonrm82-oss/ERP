import type { Metadata } from "next";
import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { COMPLETENESS_TYPES } from "@/features/data-quality/completeness";
import { CompletenessSettingsForm } from "@/features/data-quality/components/completeness-settings-form";
import { toCompletePath } from "@/features/data-quality/paths";
import { completenessCatalogFor, getCompletenessSettings } from "@/features/data-quality/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "שדות חשובים" };

type Props = { params: Promise<{ orgId: string }> };

// DQL-01: which fields count as important per record type. Owners and admins change them.
export default async function CompletenessSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const [settings, catalogs] = await Promise.all([
    getCompletenessSettings(orgId),
    Promise.all(COMPLETENESS_TYPES.map((type) => completenessCatalogFor(orgId, type))),
  ]);

  return (
    <div className="space-y-5">
      <Card aria-labelledby="completeness-about-title">
        <CardHeader id="completeness-about-title" title="שדות חשובים" />
        <CardBody className="space-y-2 text-md text-ink-soft">
          <p>
            סמנו בכל סוג רשומה אילו שדות חשוב למלא. כרטיס הרשומה מראה כמה אחוז מהם מלאים ומה חסר, ובדף{" "}
            <Link href={toCompletePath(orgId)} className="font-medium text-accent underline underline-offset-4">
              רשומות להשלמה
            </Link>{" "}
            כל אחד רואה את הרשומות שלו שחסר בהן משהו.
          </p>
          {!editable ? (
            <p>{isAdminRole(role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות את הרשימה."}</p>
          ) : null}
        </CardBody>
      </Card>
      {COMPLETENESS_TYPES.map((type, index) => (
        <CompletenessSettingsForm key={type} orgId={orgId} type={type} catalog={catalogs[index]} selected={settings[type]} editable={editable} />
      ))}
    </div>
  );
}
