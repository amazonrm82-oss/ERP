import type { Metadata } from "next";
import Form from "next/form";

import { Pagination } from "@/components/pagination";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { PlusIcon, SearchIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { ContactsTable } from "@/features/contacts/components/contacts-table";
import { CONTACT_DEFAULT_SORT, CONTACT_SORT_COLUMNS, listContacts } from "@/features/contacts/queries";
import { CUSTOM_PREFIX } from "@/features/list-columns/columns";
import { ColumnsPanel } from "@/features/list-columns/components/columns-panel";
import { getListColumns } from "@/features/list-columns/queries";
import { getOrgContext } from "@/features/shell/queries";
import { listTags } from "@/features/tags/queries";
import { SavedViewsBar } from "@/features/views/components/saved-views-bar";
import { viewChips } from "@/features/views/server";
import { isUuid, paths } from "@/lib/paths";
import { firstParam, parsePage } from "@/lib/search";
import { nextSort, parseSort, sortValue, type CustomSortKey, type Sort } from "@/lib/sort";

export const metadata: Metadata = { title: "אנשי קשר" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ContactsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const context = await getOrgContext(orgId);
  const { canWrite } = context;

  const search = firstParam(query.q).trim();
  const tagParam = firstParam(query.tag);
  const tagId = isUuid(tagParam) ? tagParam : null;
  const page = parsePage(query.page);
  const listColumns = await getListColumns(orgId, "contact");
  // any column the list can show sorts, custom fields included (LST-02, LST-03)
  const sortKeys = [...Object.keys(CONTACT_SORT_COLUMNS), ...listColumns.fields.map((f) => `${CUSTOM_PREFIX}${f.key}`)] as Array<keyof typeof CONTACT_SORT_COLUMNS | CustomSortKey>;
  const sort = parseSort(firstParam(query.sort), sortKeys, CONTACT_DEFAULT_SORT as Sort<(typeof sortKeys)[number]>);
  const [tags, views, { contacts, hasMore }] = await Promise.all([
    listTags(orgId),
    viewChips(orgId, "contact", context),
    listContacts(orgId, { search, tagId, page, sort }),
  ]);

  const listHref = (target: number, sortParam: string) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (tagId) next.set("tag", tagId);
    if (sortParam !== sortValue(CONTACT_DEFAULT_SORT)) next.set("sort", sortParam);
    if (target > 1) next.set("page", String(target));
    const suffix = next.toString();
    return suffix ? `${paths.contacts(orgId)}?${suffix}` : paths.contacts(orgId);
  };
  const hrefFor = (target: number) => listHref(target, sortValue(sort));
  // a new sort starts again from the first page; dates start with the newest
  const sortHref = (key: string) => listHref(1, sortValue(nextSort(sort, key as (typeof sortKeys)[number], key !== "created")));

  const newContactButton = canWrite ? (
    <ButtonLink href={paths.contactNew(orgId)}>
      <PlusIcon className="size-4.5" />
      איש קשר חדש
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader title="אנשי קשר" description="הלקוחות והאנשים שהעסק עובד איתם." actions={newContactButton} />

      <SavedViewsBar
        orgId={orgId}
        objectType="contact"
        listPath={paths.contacts(orgId)}
        views={views}
        current={{ q: search || undefined, tag: tagId ?? undefined }}
        canSave={context.role !== "viewer"}
        canShare={context.role === "owner" || context.role === "admin"}
      />

      <div className="mb-3 flex justify-end">
        <ColumnsPanel orgId={orgId} object="contact" catalog={listColumns.catalog} columns={listColumns.columns} saved={listColumns.saved} />
      </div>
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
        {tags.length > 0 ? (
          <SelectField label="תגית" hideLabel name="tag" defaultValue={tagId ?? ""} className="flex-[1_1_9rem] sm:max-w-52">
            <option value="">כל התגיות</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </SelectField>
        ) : null}
        <button type="submit" className={buttonClasses("secondary")}>
          <SearchIcon className="size-4.5" />
          חיפוש
        </button>
      </Form>

      {contacts.length > 0 ? (
        <ContactsTable
          orgId={orgId}
          contacts={contacts}
          columns={listColumns.columns}
          catalog={listColumns.catalog}
          fields={listColumns.fields}
          sort={sort}
          sortHref={sortHref}
        />
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          {search !== "" || tagId !== null || page > 1 ? (
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
