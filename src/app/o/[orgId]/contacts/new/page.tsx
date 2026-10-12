import type { Metadata } from "next";

import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { listCompanyOptions } from "@/features/companies/queries";
import { ContactForm } from "@/features/contacts/components/contact-form";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { listRecordTypes } from "@/features/record-type-options/queries";
import { ReadOnlyNotice } from "@/features/shell/components/read-only-notice";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "איש קשר חדש" };

type Props = { params: Promise<{ orgId: string }> };

export default async function NewContactPage({ params }: Props) {
  const { orgId } = await params;
  const { canWrite } = await getOrgContext(orgId);
  const back = { href: paths.contacts(orgId), label: "אנשי קשר" };

  if (!canWrite) {
    return (
      <>
        <PageHeader title="איש קשר חדש" back={back} />
        <ReadOnlyNotice />
      </>
    );
  }

  const [companies, fields, types] = await Promise.all([
    listCompanyOptions(orgId),
    listFieldDefinitions(orgId, "contact"),
    listRecordTypes(orgId, "contact"),
  ]);

  return (
    <div className="max-w-2xl">
      <PageHeader title="איש קשר חדש" back={back} />
      <Card>
        <CardBody>
          <ContactForm orgId={orgId} companies={companies} fields={fields} types={types} />
        </CardBody>
      </Card>
    </div>
  );
}
