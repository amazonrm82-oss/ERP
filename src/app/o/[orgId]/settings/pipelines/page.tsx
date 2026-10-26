import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { fieldsAffectedByPipelineDelete } from "@/features/custom-fields/conditions";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { CreatePipelineForm, PipelineCard } from "@/features/customization/components/pipeline-editor";
import { listPipelineSettings } from "@/features/customization/queries";
import { QuickSalePipelineForm } from "@/features/quick-sale/components/quick-sale-pipeline-form";
import { getQuickSalePipeline } from "@/features/quick-sale/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "תהליכי מכירה" };

type Props = { params: Promise<{ orgId: string }> };

export default async function PipelinesSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const [pipelines, dealFields, quickSalePipeline] = await Promise.all([
    listPipelineSettings(orgId),
    // FLD-09: deleting a pipeline removes the conditions based on it; the delete window names those fields
    editable ? listFieldDefinitions(orgId, "deal", { includeInactive: true }) : Promise.resolve([]),
    // GAP-08: the process quick sales go to
    editable ? getQuickSalePipeline(orgId) : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-5">
      <p className="text-md text-ink-soft">
        תהליך מכירה הוא השלבים שעסקה עוברת עד שהיא נסגרת. תהליך המכירה שמוגדר כברירת מחדל נפתח בלוח העסקאות, ולידים שמומרים
        נכנסים לשלב הפתוח הראשון שלו. שלב שיש בו עסקאות אי אפשר למחוק.
      </p>
      {editable ? (
        <Card aria-labelledby="new-pipeline-title">
          <CardHeader id="new-pipeline-title" title="תהליך מכירה חדש" />
          <CardBody>
            <CreatePipelineForm orgId={orgId} />
          </CardBody>
        </Card>
      ) : null}
      {editable ? (
        <Card aria-labelledby="quick-sale-pipeline-title">
          <CardHeader id="quick-sale-pipeline-title" title="מכירה מהירה" />
          <CardBody>
            <QuickSalePipelineForm orgId={orgId} pipelines={pipelines} current={quickSalePipeline} />
          </CardBody>
        </Card>
      ) : null}
      {pipelines.map((pipeline) => (
        <PipelineCard
          key={pipeline.id}
          orgId={orgId}
          pipeline={pipeline}
          editable={editable}
          isOnly={pipelines.length === 1}
          conditionFields={fieldsAffectedByPipelineDelete(
            dealFields,
            pipeline.id,
            pipeline.stages.map((stage) => stage.id),
          ).map((field) => field.label)}
        />
      ))}
    </div>
  );
}
