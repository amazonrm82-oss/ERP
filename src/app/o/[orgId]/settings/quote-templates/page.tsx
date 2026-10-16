import type { Metadata } from "next";

import { QuoteTemplatesList } from "@/features/quotes/components/quote-templates-list";
import { listQuoteTemplates } from "@/features/quotes/template-server";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "תבניות הצעת מחיר" };

type Props = { params: Promise<{ orgId: string }> };

// QUO-04: the business's quote templates. Everyone reads them; owners and admins rename and delete them.
// A template is made from a quote ("שמירה כתבנית" in the quote editor).
export default async function QuoteTemplatesPage({ params }: Props) {
  const { orgId } = await params;
  const [{ role, canWrite }, templates, hasQuotes] = await Promise.all([getOrgContext(orgId), listQuoteTemplates(orgId), orgHasFeature(orgId, "quotes")]);
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-soft">
        תבנית היא הצעה שמורה: השורות, ההערות והתנאים שלה. שומרים תבנית מתוך עורך ההצעה בכפתור &quot;שמירה כתבנית&quot;, ובוחרים בה כשיוצרים הצעה
        חדשה או בכפתור &quot;מתבנית&quot; בעורך.
      </p>
      {hasQuotes ? null : <p className="text-sm text-ink-soft">הצעות מחיר אינן כלולות בחבילה הנוכחית.</p>}
      <QuoteTemplatesList orgId={orgId} templates={templates} canEdit={isAdminRole(role) && canWrite} />
    </div>
  );
}
