import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/ui/page-header";
import { HELP_ARTICLES } from "@/features/help/articles";
import { HelpIndex } from "@/features/help/components/help-views";
import { guideQuery } from "@/features/help/guide-search";
import { GuideSearch } from "@/features/guide/components/guide-search";
import { searchOrgGuides } from "@/features/guide/search-server";
import { getOrgModules } from "@/features/modules/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "מרכז עזרה" };

// UX-05 (ג): the help center inside the business, by topic, with Hebrew search. The same articles as the public /help
// (docs/help/articles/); nothing here reads the business's data. TRU-04: the search runs on the server over the articles
// and the screens' "?" texts (`?q=`), in the business's own words; only the results reach the page.
export default async function OrgHelpPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ q?: string | string[] }> }) {
  const { orgId } = await params;
  const query = guideQuery((await searchParams).q);
  await getOrgContext(orgId);
  const results = query ? searchOrgGuides(query, await getOrgTerms(orgId), await getOrgModules(orgId)) : null;

  return (
    <>
      <PageHeader title="מרכז עזרה" description="מדריכים קצרים, צעד אחר צעד. את הסיור במערכת אפשר לראות שוב מתפריט החשבון." />
      <HelpIndex articles={HELP_ARTICLES} base={paths.orgHelp(orgId)} search={<GuideSearch orgId={orgId} query={query} results={results} />} />
      {/* UX-06: the approved articles are open to anyone too, e.g. to send to a new employee before they join */}
      <p className="mt-12 border-t border-line pt-6 text-md text-ink-soft">
        המדריכים הסופיים פתוחים גם בלי כניסה, ב
        <Link href={paths.help} className="text-accent-strong underline underline-offset-4">
          מרכז העזרה הציבורי
        </Link>
        . אפשר לשלוח את הקישור גם למי שעוד לא הצטרף.
      </p>
    </>
  );
}
