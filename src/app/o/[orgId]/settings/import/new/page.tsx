import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/ui/page-header";
import { getOrgTerms } from "@/features/terminology/queries";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { ImportWizard } from "@/features/imports/components/import-wizard";
import { canEditCatalog, canImportWith } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "ייבוא מקובץ" };

type Props = { params: Promise<{ orgId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function NewImportPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  // "?entity=product" from the products list (PRD-05); deals and tasks (IMP-03)
  const asked = (await searchParams).entity;
  const initialEntity = asked === "product" || asked === "deal" || asked === "task" ? asked : "lead";
  const { role, canWrite } = await getOrgContext(orgId);
  // PRM-01: a member with the import permission too; products also need the catalog permission
  const granted = await getMyPermissions(orgId);
  if (!canWrite || !canImportWith(role, granted)) {
    notFound();
  }
  const catalog = canEditCatalog(role, granted);
  const [lead, contact, company, deal, terms, documents] = await Promise.all([
    listFieldDefinitions(orgId, "lead"),
    listFieldDefinitions(orgId, "contact"),
    listFieldDefinitions(orgId, "company"),
    listFieldDefinitions(orgId, "deal"),
    // FLD-10: the business's words for leads, contacts and deals
    getOrgTerms(orgId),
    // GAP-12: the opening balance column needs the documents key
    orgHasFeature(orgId, "documents"),
  ]);
  const short = (defs: typeof lead) => defs.map((d) => ({ key: d.key, label: d.label }));

  return (
    <>
      <PageHeader title="ייבוא מקובץ" back={{ href: paths.imports(orgId), label: "ייבוא וייצוא" }} />
      <ImportWizard
        orgId={orgId}
        customFields={{ lead: short(lead), contact: short(contact), company: short(company), deal: short(deal), task: [], product: [] }}
        canCreateFields={isAdminRole(role)}
        canImportProducts={catalog}
        canOpeningBalance={documents && isAdminRole(role)}
        initialEntity={initialEntity === "product" && !catalog ? "lead" : initialEntity}
        terms={terms}
      />
    </>
  );
}
