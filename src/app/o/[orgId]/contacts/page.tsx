import type { Metadata } from "next";
import Form from "next/form";

import { Pagination } from "@/components/pagination";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { PlusIcon, SearchIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { ContactsTable } from "@/features/contacts/components/contacts-table";
import { listContacts } from "@/features/contacts/queries";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";
import { firstParam, parsePage } from "@/lib/search";

export const metadata: Metadata = { title: "אנשי קשר" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ContactsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const { canWrite } = await getOrgContext(orgId);

  const search = firstParam(query.q).trim();
  const page = parsePage(query.page);
  const { contacts, hasMore } = await listContacts(orgId, { search, page });

  const hrefFor = (target: number) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (target > 1) next.set("page", String(target));
    const suffix = next.toString();
    return suffix ? `${paths.contacts(orgId)}?${suffix}` : paths.contacts(orgId);
  };

  const newContactButton = canWrite ? (
    <ButtonLink href={paths.contactNew(orgId)}>
      <PlusIcon className="size-4.5" />
      איש קשר חדש
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader title="אנשי קשר" description="הלקוחות והאנשים שהעסק עובד איתם." actions={newContactButton} />

      <Form action={paths.contacts(orgId)} role="search" className="mb-4 flex flex-wrap items-end gap-2">
        <TextField
          label="חיפוש אנשי קשר"
          hideLabel
          name="q"
          type="search"
          placeholder="חיפוש לפי שם, טלפון או אימייל"
          defaultValue={search}
          className="min-w-0 flex-[1_1_14rem] sm:max-w-md"
        />
        <button type="submit" className={buttonClasses("secondary")}>
          <SearchIcon className="size-4.5" />
          חיפוש
        </button>
      </Form>

      {contacts.length > 0 ? (
        <ContactsTable orgId={orgId} contacts={contacts} />
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          {search !== "" || page > 1 ? (
            <EmptyState
              title="לא נמצאו אנשי קשר"
              description="אין אנשי קשר שמתאימים לחיפוש. נסו מילה אחרת."
              action={
                <ButtonLink href={paths.contacts(orgId)} variant="secondary">
                  ניקוי החיפוש
                </ButtonLink>
              }
            />
          ) : (
            <EmptyState
              title="עוד אין אנשי קשר"
              description="אנשי קשר נוצרים כשממירים ליד, או ידנית מכאן. לכל אחד יש ציר זמן עם כל ההערות והפעילות."
              action={newContactButton}
            />
          )}
        </div>
      )}

      <Pagination page={page} hasMore={hasMore} hrefFor={hrefFor} />
    </>
  );
}
