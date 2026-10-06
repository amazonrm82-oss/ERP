import Form from "next/form";

import { buttonClasses } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { SearchIcon } from "@/components/ui/icons";
import { paths } from "@/lib/paths";

import type { LeadStatusOption } from "../queries";

type Props = { orgId: string; statuses: LeadStatusOption[]; search: string; statusId: string };

/** Search + status filter. A GET form: the filters live in the URL, so they can be shared and survive a refresh. */
export function LeadFilters({ orgId, statuses, search, statusId }: Props) {
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
      <button type="submit" className={buttonClasses("secondary")}>
        <SearchIcon className="size-4.5" />
        חיפוש
      </button>
    </Form>
  );
}
