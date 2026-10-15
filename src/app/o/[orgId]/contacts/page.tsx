import type { Metadata } from "next";
import Form from "next/form";

import { ListTools } from "@/components/list-tools";
import { contactDisplayName } from "@/features/contacts/display";
import { RecordCards } from "@/components/record-cards";
import { Pagination } from "@/components/ui/pagination";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { PlusIcon, SearchIcon, UsersIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { ContactsTable } from "@/features/contacts/components/contacts-table";
import { getScoreNumbers } from "@/features/data-quality/queries";
import { CONTACT_DEFAULT_SORT, CONTACT_SORT_COLUMNS, listContacts } from "@/features/contacts/queries";
import { inlineEditing } from "@/features/inline-edit/server";
import { CUSTOM_PREFIX, resolveColumns } from "@/features/list-columns/columns";
import { ColumnsPanel } from "@/features/list-columns/components/columns-panel";
import { getListColumns } from "@/features/list-columns/queries";
import { ExportMenu, exportHref } from "@/features/list-export/components/export-menu";
import { AdvancedFilter } from "@/features/list-filters/components/advanced-filter";
import { prepareListFilter, startListFilterLookups } from "@/features/list-filters/prepare";
import { getMyPermissions } from "@/features/permissions/queries";
import { canExport } from "@/features/reports/request";
import { getOrgContext } from "@/features/shell/queries";
import { listWhatsappLog, whatsappListContext } from "@/features/whatsapp/templates";
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
  // PRM-01: extra permissions (export)
  const granted = await getMyPermissions(orgId);
  const { canWrite } = context;

  const search = firstParam(query.q).trim();
  const tagParam = firstParam(query.tag);
  const tagId = isUuid(tagParam) ? tagParam : null;
  const page = parsePage(query.page);
  // FXC-09: the columns and the filter's choices load side by side; prepareListFilter reuses the same reads
  const [listColumns] = await Promise.all([getListColumns(orgId, "contact"), startListFilterLookups(orgId, "contact")]);
  // the advanced filter (LST-05), checked against the list's fields
  const filter = await prepareListFilter(orgId, "contact", firstParam(query.f), context.user.id, listColumns.fields);
  const filterParam = filter.tree ? JSON.stringify(filter.tree) : null;
  // any column the list can show sorts, custom fields included (LST-02, LST-03)
  const sortKeys = [...Object.keys(CONTACT_SORT_COLUMNS), ...listColumns.fields.map((f) => `${CUSTOM_PREFIX}${f.key}`)] as Array<
    keyof typeof CONTACT_SORT_COLUMNS | CustomSortKey
  >;
  const sort = parseSort(firstParam(query.sort), sortKeys, CONTACT_DEFAULT_SORT as Sort<(typeof sortKeys)[number]>);
  const [editing, tags, viewData, { contacts, hasMore }] = await Promise.all([
    inlineEditing(orgId, context),
    listTags(orgId),
    viewChips(orgId, "contact", context),
    listContacts(orgId, { search, tagId, page, sort, filter: filter.logic }),
  ]);

  const views = viewData.chips;
  // a saved view in use (LST-04): its columns replace the user's own while it is open
  const activeView = views.find((view) => view.id === firstParam(query.sv)) ?? null;
  const shownColumns = activeView?.config.columns ? resolveColumns("contact", activeView.config.columns, listColumns.catalog) : listColumns.columns;
  // DQL-01: scores only when the column is shown
  const completeness = shownColumns.some((c) => c.key === "completeness") && contacts.length > 0 ? await getScoreNumbers(orgId, "contact", contacts.map((c) => c.id)) : undefined;

  const listHref = (target: number, sortParam: string) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (tagId) next.set("tag", tagId);
    if (sortParam !== sortValue(CONTACT_DEFAULT_SORT)) next.set("sort", sortParam);
    if (filterParam) next.set("f", filterParam);
    if (activeView) next.set("sv", activeView.id);
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

      <ListTools active={(filter.tree ? 1 : 0) + (tagId ? 1 : 0)}>
        <SavedViewsBar
          orgId={orgId}
          objectType="contact"
          listPath={paths.contacts(orgId)}
          views={views}
          activeViewId={activeView?.id ?? null}
          current={{ q: search || undefined, f: filterParam ?? undefined, tag: tagId ?? undefined }}
          currentSort={sortValue(sort)}
          currentColumns={shownColumns}
          teams={viewData.teams}
          canSave={context.role !== "viewer"}
          canShare={context.role === "owner" || context.role === "admin"}
        />

        <div className="flex flex-wrap items-start gap-2 md:justify-end">
          {canExport(context.role, granted) ? <ExportMenu href={exportHref(paths.contacts(orgId), listHref(1, sortValue(sort)))} /> : null}
          <AdvancedFilter
            fields={filter.fields}
            current={filter.tree}
            skipped={filter.skipped}
            listPath={paths.contacts(orgId)}
            keep={Object.fromEntries(Object.entries({ q: search, tag: tagId ?? "" }).filter(([, v]) => v))}
          />
          {activeView?.config.columns ? (
            <p className="py-2 text-sm text-ink-soft">העמודות לפי התצוגה &quot;{activeView.name}&quot;</p>
          ) : (
            <ColumnsPanel orgId={orgId} object="contact" catalog={listColumns.catalog} columns={listColumns.columns} saved={listColumns.saved} />
          )}
        </div>
      </ListTools>
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
        <>
          <RecordCards
            label="אנשי קשר"
            className="md:hidden"
            cards={contacts.map((contact) => ({
              id: contact.id,
              href: paths.contact(orgId, contact.id),
              title: contactDisplayName(contact),
              details: [contact.typeName, contact.companyName, contact.jobTitle, contact.ownerName ? `אחראי: ${contact.ownerName}` : null],
              phone: contact.phone,
              phoneE164: contact.phoneE164,
              whatsappLog: listWhatsappLog(whatsappListContext(context), {
                subject: { kind: "contact", id: contact.id },
                name: contactDisplayName(contact),
                phoneE164: contact.phoneE164,
                firstName: contact.firstName,
                fullName: contact.fullName,
              }),
            }))}
          />
          <div className="hidden md:block">
            <ContactsTable
              orgId={orgId}
              contacts={contacts}
              columns={shownColumns}
              catalog={listColumns.catalog}
              fields={listColumns.fields}
              sort={sort}
              sortHref={sortHref}
              editing={editing}
              tags={tags}
              completeness={completeness}
              whatsapp={whatsappListContext(context)}
            />
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          {search !== "" || tagId !== null || filter.tree !== null || page > 1 ? (
            <EmptyState kind="search"
              title="לא נמצאו אנשי קשר"
              description="אין אנשי קשר שמתאימים לחיפוש או לסינון. נסו מילה אחרת או נקו את הסינון."
              action={
                <ButtonLink href={paths.contacts(orgId)} variant="secondary">
                  ניקוי הסינון
                </ButtonLink>
              }
            />
          ) : (
            <EmptyState icon={<UsersIcon />}
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
