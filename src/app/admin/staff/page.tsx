import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SelectField, TextField } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { setStaffAction } from "@/features/platform/actions";
import { PlatformForm } from "@/features/platform/components/platform-form";
import { PLATFORM_ROLE_LABELS } from "@/features/platform/labels";
import { getPlatformMe, listPlatformStaff } from "@/features/platform/queries";
import type { PlatformRole } from "@/lib/database.types";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "צוות הפלטפורמה" };

const ROLE_HINTS: Record<PlatformRole, string> = {
  owner: "הכול, כולל חבילות, צוות ומצב ארגונים",
  support: "צפייה בארגונים, וכניסה לארגון שאישר גישת תמיכה",
  finance: "שינוי חבילה, מושבים והארכת ניסיון",
  readonly: "צפייה ברשימות ובמדדים בלבד",
};

export default async function AdminStaffPage() {
  const me = await getPlatformMe();
  if (me?.role !== "owner") {
    return <p>רק בעלי הפלטפורמה מנהלים את הצוות.</p>;
  }
  const staff = await listPlatformStaff();

  return (
    <>
      <PageHeader title="צוות הפלטפורמה" description="כל אחד בצוות חייב אימות דו-שלבי. בלי אישור של לקוח, אף אחד בצוות לא רואה את הנתונים שלו." />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card aria-labelledby="staff-list">
          <CardHeader id="staff-list" title="חברי הצוות" />
          <ul className="divide-y divide-line">
            {staff.map((s) => (
              <li key={String(s.user_id)} className="px-4 py-3 sm:px-5">
                <p className="font-medium">
                  {String(s.name ?? "")} <span dir="ltr" className="font-normal text-ink-soft">{String(s.email)}</span>
                </p>
                <p className="text-sm text-ink-soft">
                  {PLATFORM_ROLE_LABELS[s.role as PlatformRole]} · מ-{formatDate(String(s.created_at))}
                </p>
              </li>
            ))}
          </ul>
        </Card>
        <Card aria-labelledby="staff-add">
          <CardHeader id="staff-add" title="הוספה או שינוי" />
          <CardBody>
            <PlatformForm action={setStaffAction} submitLabel="שמירה">
              <TextField label="אימייל" name="email" type="email" dir="ltr" required hint="המשתמש צריך להיות רשום במערכת" />
              <SelectField label="תפקיד" name="role" defaultValue="support">
                {(Object.keys(PLATFORM_ROLE_LABELS) as PlatformRole[]).map((role) => (
                  <option key={role} value={role}>
                    {PLATFORM_ROLE_LABELS[role]}: {ROLE_HINTS[role]}
                  </option>
                ))}
                <option value="remove">הסרה מהצוות</option>
              </SelectField>
            </PlatformForm>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
