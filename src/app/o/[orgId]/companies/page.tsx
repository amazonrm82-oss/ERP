import type { Metadata } from "next";
import Form from "next/form";

import { Pagination } from "@/components/pagination";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { PlusIcon, SearchIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { CompaniesTable } from "@/features/companies/components/companies-table";
import { listCompanies } from "@/features/companies/queries";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";
import { firstParam, parsePage } from "@/lib/search";

export const metadata: Metadata = { title: "חברות" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function CompaniesPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const { canWrite } = await getOrgContext(orgId);

  const search = firstParam(query.q).trim();
  const page = parsePage(query.page);
  const { companies, hasMore } = await listCompanies(orgId, { search, page });

  const hrefFor = (target: number) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (target > 1) next.set("page", String(target));
    const suffix = next.toString();
    return suffix ? `${paths.companies(orgId)}?${suffix}` : paths.companies(orgId);
  };

  const newCompanyButton = canWrite ? (
    <ButtonLink href={paths.companyNew(orgId)}>
      <PlusIcon className="size-4.5" />
      חברה חדשה
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader title="חברות" description="הארגונים שהעסק עובד איתם, ואנשי הקשר והעסקאות של כל אחד." actions={newCompanyButton} />

      <Form action={paths.companies(orgId)} role="search" className="mb-4 flex flex-wrap items-end gap-2">
        <TextField
          label="חיפוש חברות"
          hideLabel
          name="q"
          type="search"
          placeholder="חיפוש לפי שם, ח.פ., עיר או טלפון"
          defaultValue={search}
          className="min-w-0 flex-[1_1_14rem] sm:max-w-md"
        />
        <button type="submit" className={buttonClasses("secondary")}>
          <SearchIcon className="size-4.5" />
          חיפוש
        </button>
      </Form>

      {companies.length > 0 ? (
        <CompaniesTable orgId={orgId} companies={companies} />
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          {search !== "" || page > 1 ? (
            <EmptyState
              title="לא נמצאו חברות"
              description="אין חברות שמתאימות לחיפוש. נסו מילה אחרת."
              action={
                <ButtonLink href={paths.companies(orgId)} variant="secondary">
                  ניקוי החיפוש
                </ButtonLink>
              }
            />
          ) : (
            <EmptyState
              title="עוד אין חברות"
              description="חברה נוצרת כשממירים ליד עם שם חברה, או ידנית מכאן."
              action={newCompanyButton}
            />
          )}
        </div>
      )}

      <Pagination page={page} hasMore={hasMore} hrefFor={hrefFor} />
    </>
  );
}
