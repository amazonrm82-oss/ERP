import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { CreateTagForm, TagList } from "@/features/tags/components/tag-settings";
import { listTags } from "@/features/tags/queries";

export const metadata: Metadata = { title: "תגיות" };

type Props = { params: Promise<{ orgId: string }> };

export default async function TagsSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const tags = await listTags(orgId);

  return (
    <Card aria-labelledby="tags-title">
      <CardHeader id="tags-title" title={`תגיות (${tags.length})`} />
      <CardBody className="pb-0 text-[0.9375rem] text-ink-soft">
        תגיות מסמנות רשומות לפי מה שחשוב לעסק, למשל &quot;VIP&quot; או &quot;תערוכה 2026&quot;. מוסיפים תגית לרשומה בכרטיס שלה, ומסננים לפיה ברשימות.
      </CardBody>
      {tags.length === 0 ? (
        <EmptyState title="עוד אין תגיות" />
      ) : (
        <div className="mt-3 border-t border-line">
          <TagList orgId={orgId} tags={tags} editable={editable} />
        </div>
      )}
      {editable ? (
        <CardBody className="border-t border-line">
          <CreateTagForm orgId={orgId} />
        </CardBody>
      ) : null}
    </Card>
  );
}
