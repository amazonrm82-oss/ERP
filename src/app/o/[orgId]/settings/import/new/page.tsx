import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/ui/page-header";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { ImportWizard } from "@/features/imports/components/import-wizard";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "ייבוא מקובץ" };

export default async function NewImportPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  if (!canWrite || !(isAdminRole(role) || role === "manager")) {
    notFound();
  }
  const [lead, contact, company] = await Promise.all([
    listFieldDefinitions(orgId, "lead"),
    listFieldDefinitions(orgId, "contact"),
    listFieldDefinitions(orgId, "company"),
  ]);
  const short = (defs: typeof lead) => defs.map((d) => ({ key: d.key, label: d.label }));

  return (
    <>
      <PageHeader title="ייבוא מקובץ" back={{ href: paths.imports(orgId), label: "ייבוא וייצוא" }} />
      <ImportWizard orgId={orgId} customFields={{ lead: short(lead), contact: short(contact), company: short(company) }} />
    </>
  );
}
