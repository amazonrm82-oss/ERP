import type { Metadata } from "next";
import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { CreateFieldForm, FieldList } from "@/features/custom-fields/components/field-editor";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { FIELD_OBJECT_LABELS, FIELD_OBJECTS, type FieldObject } from "@/features/custom-fields/types";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { cn } from "@/lib/cn";
import { paths } from "@/lib/paths";
import { firstParam } from "@/lib/search";

export const metadata: Metadata = { title: "שדות מותאמים" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function FieldsSettingsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const requested = firstParam((await searchParams).object);
  const objectType: FieldObject = (FIELD_OBJECTS as readonly string[]).includes(requested) ? (requested as FieldObject) : "lead";
  const editable = isAdminRole(role) && canWrite;
  const fields = await listFieldDefinitions(orgId, objectType, { includeInactive: true });

  return (
    <div className="space-y-5">
      <p className="text-md text-ink-soft">
        שדות נוספים שהעסק צריך, למשל תקציב, תחום עניין או מספר חשבון. הם מופיעים בטופס ובכרטיס של כל רשומה מהסוג שנבחר.
      </p>
      <nav aria-label="סוג רשומה" className="flex flex-wrap gap-2">
        {FIELD_OBJECTS.map((object) => (
          <Link
            key={object}
            href={`${paths.settingsFields(orgId)}?object=${object}`}
            aria-current={object === objectType ? "page" : undefined}
            className={cn(
              "inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm",
              object === objectType ? "border-accent bg-accent-soft font-semibold text-accent-strong" : "border-line bg-surface hover:bg-canvas",
            )}
          >
            {FIELD_OBJECT_LABELS[object]}
          </Link>
        ))}
      </nav>

      <Card aria-labelledby="fields-title">
        <CardHeader id="fields-title" title={`שדות של ${FIELD_OBJECT_LABELS[objectType]}`} />
        {fields.length === 0 ? (
          <EmptyState title="עוד אין שדות" description="שדה חדש מוסיפים בטופס שלמטה." />
        ) : (
          <FieldList orgId={orgId} fields={fields} editable={editable} />
        )}
      </Card>

      {editable ? (
        <Card aria-labelledby="new-field-title">
          <CardHeader id="new-field-title" title="שדה חדש" />
          <CardBody>
            <CreateFieldForm key={objectType} orgId={orgId} objectType={objectType} />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
