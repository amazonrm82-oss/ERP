import type { Metadata } from "next";

import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { CompanyForm } from "@/features/companies/components/company-form";
import { listPriceLists } from "@/features/price-lists/queries";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { listRecordTypes } from "@/features/record-type-options/queries";
import { ReadOnlyNotice } from "@/features/shell/components/read-only-notice";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "חברה חדשה" };

type Props = { params: Promise<{ orgId: string }> };

export default async function NewCompanyPage({ params }: Props) {
  const { orgId } = await params;
  const { canWrite } = await getOrgContext(orgId);
  const back = { href: paths.companies(orgId), label: "חברות" };

  if (!canWrite) {
    return (
      <>
        <PageHeader title="חברה חדשה" back={back} />
        <ReadOnlyNotice />
      </>
    );
  }

  const [fields, types, priceLists] = await Promise.all([listFieldDefinitions(orgId, "company"), listRecordTypes(orgId, "company"), listPriceLists(orgId)]);

  return (
    <div className="max-w-2xl">
      <PageHeader title="חברה חדשה" back={back} />
      <Card>
        <CardBody>
          <CompanyForm orgId={orgId} fields={fields} types={types} priceLists={priceLists} />
        </CardBody>
      </Card>
    </div>
  );
}
