import type { Metadata } from "next";

import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { listCompanyOptions } from "@/features/companies/queries";
import { ContactForm } from "@/features/contacts/components/contact-form";
import { listPriceLists } from "@/features/price-lists/queries";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { listRecordTypes } from "@/features/record-type-options/queries";
import { ReadOnlyNotice } from "@/features/shell/components/read-only-notice";
import { getOrgTerms } from "@/features/terminology/queries";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export async function generateMetadata({ params }: { params: Promise<{ orgId: string }> }): Promise<Metadata> {
  // FLD-10: the business's own word
  return { title: (await getOrgTerms((await params).orgId)).contact.newOne };
}

type Props = { params: Promise<{ orgId: string }> };

export default async function NewContactPage({ params }: Props) {
  const { orgId } = await params;
  const { canWrite } = await getOrgContext(orgId);
  const term = (await getOrgTerms(orgId)).contact;
  const back = { href: paths.contacts(orgId), label: term.plural };

  if (!canWrite) {
    return (
      <>
        <PageHeader title={term.newOne} back={back} />
        <ReadOnlyNotice />
      </>
    );
  }

  const [companies, fields, types, priceLists] = await Promise.all([
    listCompanyOptions(orgId),
    listFieldDefinitions(orgId, "contact"),
    listRecordTypes(orgId, "contact"),
    listPriceLists(orgId),
  ]);

  return (
    <div className="max-w-2xl">
      <PageHeader title={term.newOne} back={back} />
      <Card>
        <CardBody>
          <ContactForm orgId={orgId} companies={companies} fields={fields} types={types} priceLists={priceLists} />
        </CardBody>
      </Card>
    </div>
  );
}
