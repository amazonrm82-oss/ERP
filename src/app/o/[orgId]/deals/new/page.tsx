import type { Metadata } from "next";

import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { listContactOptions } from "@/features/contacts/queries";
import { DealForm } from "@/features/deals/components/deal-form";
import { getDefaultPipeline } from "@/features/deals/queries";
import { ReadOnlyNotice } from "@/features/shell/components/read-only-notice";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid, paths } from "@/lib/paths";
import { firstParam } from "@/lib/search";

export const metadata: Metadata = { title: "עסקה חדשה" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function NewDealPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const { canWrite } = await getOrgContext(orgId);
  const back = { href: paths.deals(orgId), label: "עסקאות" };

  if (!canWrite) {
    return (
      <>
        <PageHeader title="עסקה חדשה" back={back} />
        <ReadOnlyNotice />
      </>
    );
  }

  const [pipeline, contacts] = await Promise.all([getDefaultPipeline(orgId), listContactOptions(orgId)]);
  const contactParam = firstParam((await searchParams).contact);
  // only preselect a contact that is actually in the list
  const defaultContactId = isUuid(contactParam) && contacts.some((contact) => contact.id === contactParam) ? contactParam : "";

  return (
    <div className="max-w-2xl">
      <PageHeader title="עסקה חדשה" back={back} description={pipeline ? `פייפליין ${pipeline.name}` : undefined} />
      <Card>
        {pipeline && pipeline.stages.length > 0 ? (
          <CardBody>
            <DealForm orgId={orgId} stages={pipeline.stages} contacts={contacts} defaultContactId={defaultContactId} />
          </CardBody>
        ) : (
          <EmptyState
            title="אין שלבים בפייפליין"
            description="כדי ליצור עסקה צריך פייפליין עם שלב אחד לפחות. מנהל המערכת יכול להוסיף בהגדרות."
          />
        )}
      </Card>
    </div>
  );
}
