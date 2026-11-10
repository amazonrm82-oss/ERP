import Form from "next/form";

import { buttonClasses } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { SearchIcon } from "@/components/ui/icons";
import type { TagOption } from "@/features/tags/queries";
import { paths } from "@/lib/paths";

import type { LeadStatusOption } from "../queries";

type Props = {
  orgId: string;
  statuses: LeadStatusOption[];
  tags: TagOption[];
  search: string;
  statusId: string;
  tagId: string;
  // the board shows every status as a column, so it has no status filter
  board?: boolean;
};

/**
 * Search + status + tag filter. A GET form: the filters live in the URL, so they can be shared and survive a refresh.
 * On a phone (below md) only the search is in this row; status and tag wait inside "סינון ותצוגה" (LeadPhoneFilters).
 * The hidden selects still send their values, so a new search keeps the chosen status and tag.
 */
export function LeadFilters({ orgId, statuses, tags, search, statusId, tagId, board = false }: Props) {
  return (
    <Form action={paths.leads(orgId)} role="search" className="mb-4 flex items-end gap-2 max-md:flex-nowrap md:flex-wrap">
      {board ? <input type="hidden" name="view" value="board" /> : null}
      <TextField
        label="חיפוש לידים"
        hideLabel
        name="q"
        type="search"
        placeholder="חיפוש לפי שם, טלפון או אימייל"
        defaultValue={search}
        className="min-w-0 flex-[1_1_14rem]"
      />
      {board ? null : (
        <SelectField label="סטטוס" hideLabel name="status" defaultValue={statusId} className="flex-[1_1_9rem] max-md:hidden sm:max-w-52">
          <option value="">כל הסטטוסים</option>
          {statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </SelectField>
      )}
      {tags.length > 0 ? (
        <SelectField label="תגית" hideLabel name="tag" defaultValue={tagId} className="flex-[1_1_9rem] max-md:hidden sm:max-w-52">
          <option value="">כל התגיות</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </SelectField>
      ) : null}
      <button type="submit" className={buttonClasses("secondary", "md", "shrink-0")}>
        <SearchIcon className="size-4.5" />
        חיפוש
      </button>
    </Form>
  );
}

/** The phone's status and tag filter, inside "סינון ותצוגה" (UX-01 phone fixes). Keeps the search; hidden from md up. */
export function LeadPhoneFilters({ orgId, statuses, tags, search, statusId, tagId, board = false }: Props) {
  if (board && tags.length === 0) return null;
  return (
    <Form action={paths.leads(orgId)} className="flex flex-col gap-2 md:hidden">
      {board ? <input type="hidden" name="view" value="board" /> : null}
      {search ? <input type="hidden" name="q" value={search} /> : null}
      {board ? null : (
        <SelectField label="סטטוס" name="status" defaultValue={statusId}>
          <option value="">כל הסטטוסים</option>
          {statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </SelectField>
      )}
      {tags.length > 0 ? (
        <SelectField label="תגית" name="tag" defaultValue={tagId}>
          <option value="">כל התגיות</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </SelectField>
      ) : null}
      <button type="submit" className={buttonClasses("secondary", "md", "self-start")}>
        סינון
      </button>
    </Form>
  );
}
