import type { Metadata } from "next";

import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { activeReasonNames } from "@/features/disqualify-reasons/queries";
import { LeadForm } from "@/features/leads/components/lead-form";
import { getLeadLookups } from "@/features/leads/queries";
import { requestedProductEnabled } from "@/features/requested-product/queries";
import { ReadOnlyNotice } from "@/features/shell/components/read-only-notice";
import { getOrgTerms } from "@/features/terminology/queries";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export async function generateMetadata({ params }: { params: Promise<{ orgId: string }> }): Promise<Metadata> {
  // FLD-10: the business's own word
  return { title: (await getOrgTerms((await params).orgId)).lead.newOne };
}

type Props = { params: Promise<{ orgId: string }> };

export default async function NewLeadPage({ params }: Props) {
  const { orgId } = await params;
  const { canWrite } = await getOrgContext(orgId);
  const term = (await getOrgTerms(orgId)).lead;
  const back = { href: paths.leads(orgId), label: term.plural };

  if (!canWrite) {
    return (
      <>
        <PageHeader title={term.newOne} back={back} />
        <ReadOnlyNotice />
      </>
    );
  }

  const [{ statuses, sources }, fields, reasons, products] = await Promise.all([
    getLeadLookups(orgId),
    listFieldDefinitions(orgId, "lead"),
    activeReasonNames(orgId),
    // LEAD-04
    requestedProductEnabled(orgId),
  ]);

  return (
    <div className="max-w-2xl">
      <PageHeader title={term.newOne} back={back} />
      <Card>
        <CardBody>
          <LeadForm orgId={orgId} statuses={statuses} sources={sources} fields={fields} reasons={reasons} products={products} />
        </CardBody>
      </Card>
    </div>
  );
}
