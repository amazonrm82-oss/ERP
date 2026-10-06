import type { Metadata } from "next";

import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { CompanyForm } from "@/features/companies/components/company-form";
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

  return (
    <div className="max-w-2xl">
      <PageHeader title="חברה חדשה" back={back} />
      <Card>
        <CardBody>
          <CompanyForm orgId={orgId} />
        </CardBody>
      </Card>
    </div>
  );
}
