import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";

import { modulesSettingsPath } from "../paths";

type Props = { orgId: string; title: string; canChange: boolean };

/** LEAD-08: what a page of a switched-off module shows instead of itself. Nothing was removed; the setting brings it back. */
export function ModuleOff({ orgId, title, canChange }: Props) {
  return (
    <Card aria-labelledby="module-off-title">
      <CardHeader id="module-off-title" title="המודול כבוי" />
      <CardBody className="space-y-3">
        <p>{`${title} כבוי בעסק הזה. שום דבר לא נמחק: כשמפעילים אותו מחדש, כל המידע חוזר להופיע.`}</p>
        {canChange ? (
          <p>
            <Link href={modulesSettingsPath(orgId)} className="font-medium text-accent underline underline-offset-4">
              להגדרת המודולים
            </Link>
          </p>
        ) : (
          <p className="text-ink-soft">להפעלה מחדש, פנו לבעלים או למנהלי המערכת של העסק.</p>
        )}
      </CardBody>
    </Card>
  );
}
