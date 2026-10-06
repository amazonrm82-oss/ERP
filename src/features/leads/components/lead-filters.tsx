import Form from "next/form";

import { buttonClasses } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { SearchIcon } from "@/components/ui/icons";
import type { TagOption } from "@/features/tags/queries";
import { paths } from "@/lib/paths";

import type { LeadStatusOption } from "../queries";

type Props = { orgId: string; statuses: LeadStatusOption[]; tags: TagOption[]; search: string; statusId: string; tagId: string };

/** Search + status + tag filter. A GET form: the filters live in the URL, so they can be shared and survive a refresh. */
export function LeadFilters({ orgId, statuses, tags, search, statusId, tagId }: Props) {
  return (
    <Form action={paths.leads(orgId)} role="search" className="mb-4 flex flex-wrap items-end gap-2">
      <TextField
        label="חיפוש לידים"
        hideLabel
        name="q"
        type="search"
        placeholder="חיפוש לפי שם, טלפון או אימייל"
        defaultValue={search}
        className="min-w-0 flex-[1_1_14rem]"
      />
      <SelectField label="סטטוס" hideLabel name="status" defaultValue={statusId} className="flex-[1_1_9rem] sm:max-w-52">
        <option value="">כל הסטטוסים</option>
        {statuses.map((status) => (
          <option key={status.id} value={status.id}>
            {status.name}
          </option>
        ))}
      </SelectField>
      {tags.length > 0 ? (
        <SelectField label="תגית" hideLabel name="tag" defaultValue={tagId} className="flex-[1_1_9rem] sm:max-w-52">
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
  );
}
