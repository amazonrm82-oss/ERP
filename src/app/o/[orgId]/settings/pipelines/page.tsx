import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CreatePipelineForm, PipelineCard } from "@/features/customization/components/pipeline-editor";
import { listPipelineSettings } from "@/features/customization/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "פייפליינים" };

type Props = { params: Promise<{ orgId: string }> };

export default async function PipelinesSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const pipelines = await listPipelineSettings(orgId);

  return (
    <div className="space-y-5">
      <p className="text-[0.9375rem] text-ink-soft">
        פייפליין הוא תהליך המכירה: השלבים שעסקה עוברת עד שהיא נסגרת. פייפליין ברירת המחדל נפתח בלוח העסקאות, ולידים שמומרים
        נכנסים לשלב הפתוח הראשון שלו. שלב שיש בו עסקאות אי אפשר למחוק.
      </p>
      {editable ? (
        <Card aria-labelledby="new-pipeline-title">
          <CardHeader id="new-pipeline-title" title="פייפליין חדש" />
          <CardBody>
            <CreatePipelineForm orgId={orgId} />
          </CardBody>
        </Card>
      ) : null}
      {pipelines.map((pipeline) => (
        <PipelineCard key={pipeline.id} orgId={orgId} pipeline={pipeline} editable={editable} isOnly={pipelines.length === 1} />
      ))}
    </div>
  );
}
