import type { Metadata } from "next";

import { Card, CardBody } from "@/components/ui/card";
import { BoardIcon } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { listCompanyOptions } from "@/features/companies/queries";
import { getOrgModules } from "@/features/modules/queries";
import { getContactChoice } from "@/features/contacts/queries";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { DealForm } from "@/features/deals/components/deal-form";
import { getPipeline } from "@/features/deals/queries";
import { ReadOnlyNotice } from "@/features/shell/components/read-only-notice";
import { getOrgTerms } from "@/features/terminology/queries";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid, paths } from "@/lib/paths";
import { firstParam } from "@/lib/search";

export async function generateMetadata({ params }: { params: Promise<{ orgId: string }> }): Promise<Metadata> {
  // FLD-10: the business's own word
  return { title: (await getOrgTerms((await params).orgId)).deal.newOne };
}

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function NewDealPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const { canWrite } = await getOrgContext(orgId);
  const term = (await getOrgTerms(orgId)).deal;
  const back = { href: paths.deals(orgId), label: term.plural };

  if (!canWrite) {
    return (
      <>
        <PageHeader title={term.newOne} back={back} />
        <ReadOnlyNotice />
      </>
    );
  }

  const query = await searchParams;
  const contactParam = firstParam(query.contact);
  const [pipeline, defaultContact, companies, fields] = await Promise.all([
    getPipeline(orgId, firstParam(query.pipeline)),
    // only preselect a contact the user may read and that is not in the bin
    getContactChoice(orgId, contactParam),
    // LEAD-08: with companies switched off there is no company field (null)
    getOrgModules(orgId).then((modules) => (modules.companies ? listCompanyOptions(orgId) : null)),
    listFieldDefinitions(orgId, "deal"),
  ]);
  const companyParam = firstParam(query.company);
  const defaultCompanyId = isUuid(companyParam) && companies?.some((company) => company.id === companyParam) ? companyParam : "";

  return (
    <div className="max-w-2xl">
      <PageHeader title={term.newOne} back={back} description={pipeline ? `תהליך המכירה "${pipeline.name}"` : undefined} />
      <Card>
        {pipeline && pipeline.stages.length > 0 ? (
          <CardBody>
            <DealForm
              orgId={orgId}
              pipelineId={pipeline.id}
              stages={pipeline.stages}
              companies={companies}
              defaultContact={defaultContact}
              defaultCompanyId={defaultCompanyId}
              fields={fields}
            />
          </CardBody>
        ) : (
          <EmptyState icon={<BoardIcon />}
            title="אין שלבים בתהליך המכירה"
            description="כדי ליצור עסקה צריך תהליך מכירה עם שלב אחד לפחות. מנהל המערכת יכול להוסיף בהגדרות."
          />
        )}
      </Card>
    </div>
  );
}
