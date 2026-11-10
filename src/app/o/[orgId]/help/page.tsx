import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/page-header";
import { HELP_ARTICLES } from "@/features/help/articles";
import { HelpIndex } from "@/features/help/components/help-views";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "מרכז עזרה" };

// UX-05 (ג): the help center inside the business, by topic, with Hebrew search. The same articles as the public /help
// (docs/help/articles/); nothing here reads the business's data.
export default async function OrgHelpPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await getOrgContext(orgId);

  return (
    <>
      <PageHeader title="מרכז עזרה" description="מדריכים קצרים, צעד אחר צעד. את הסיור במערכת אפשר לראות שוב מתפריט החשבון." />
      <HelpIndex articles={HELP_ARTICLES} base={paths.orgHelp(orgId)} />
    </>
  );
}
