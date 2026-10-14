import { Fragment, type ReactNode } from "react";

import { Detail, DetailList } from "@/components/detail-list";
import { fieldState } from "@/features/custom-fields/conditions";
import type { CustomValues, FieldDefinition, FieldObject } from "@/features/custom-fields/types";
import { displayCustomFields } from "@/features/custom-fields/values";

import { CARD_LAYOUT_BUILT_IN, CUSTOM_PREFIX, groupHeadings, resolveLayout, splitColumns, unsavedLayout, type CardLayoutGroup, type CardLayoutType } from "../layout";

// a built-in field as the card shows it; null/undefined = not shown on this record (e.g. the loss reason of an open deal)
export type BuiltInDetail = { value: ReactNode; ltr?: boolean; label?: string } | null | undefined;

type Props = {
  type: CardLayoutType & FieldObject;
  // the business's layout (FLD-08); null = the default layout
  layout: CardLayoutGroup[] | null;
  builtIn: Partial<Record<string, BuiltInDetail>>;
  custom: { definitions: FieldDefinition[]; values: CustomValues; builtins?: Record<string, string | null> };
  // a stable prefix for the group heading ids
  idPrefix: string;
};

type Item = { key: string; label: string; value: ReactNode; ltr?: boolean };

/**
 * The details of a record card arranged by the business's groups (FLD-08). Fields whose FLD-09
 * "show" condition does not hold are left out; a field the layout does not place shows in a
 * final group "שדות נוספים". A single group shows its heading only when the business named it
 * (groupHeadings); without a heading it is plain lists under the card's own heading, with no
 * section, so no unnamed region is announced.
 */
export function LayoutDetails({ type, layout, builtIn, custom, idPrefix }: Props) {
  const items = new Map<string, Item>();
  for (const field of CARD_LAYOUT_BUILT_IN[type]) {
    const detail = builtIn[field.key];
    if (detail) items.set(field.key, { key: field.key, label: detail.label ?? field.label, value: detail.value, ltr: detail.ltr });
  }
  const conditionValues = { ...custom.values, ...(custom.builtins ?? {}) };
  const shown = custom.definitions.filter((field) => fieldState(field, custom.definitions, conditionValues, type).visible);
  for (const field of displayCustomFields(shown, custom.values)) {
    items.set(`${CUSTOM_PREFIX}${field.key}`, {
      key: `${CUSTOM_PREFIX}${field.key}`,
      label: field.label,
      ltr: field.ltr,
      value:
        field.href && field.text ? (
          <a href={field.href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-4">
            {field.text.replace(/^https?:\/\//, "")}
          </a>
        ) : (
          field.text
        ),
    });
  }

  const known = [...items.keys()];
  // no saved layout: exactly today's card (one list of every field, no heading, no cap)
  const groups = layout ? resolveLayout(layout, known) : unsavedLayout(known);
  const headings = groupHeadings(groups);

  return (
    <div className="space-y-4">
      {groups.map((group, index) => {
        const headingId = `${idPrefix}-group-${index}`;
        const columns = splitColumns(group.fields.map((key) => items.get(key)).filter((item): item is Item => Boolean(item)), group.columns);
        const lists = (
          <div className={group.columns === 2 ? "grid gap-x-6 gap-y-3 sm:grid-cols-2" : undefined}>
            {columns.map((column, c) => (
              <DetailList key={c}>
                {column.map((item) => (
                  <Fragment key={item.key}>
                    <Detail label={item.label} value={item.value} ltr={item.ltr} />
                  </Fragment>
                ))}
              </DetailList>
            ))}
          </div>
        );
        if (!headings[index]) return <Fragment key={index}>{lists}</Fragment>;
        return (
          <section key={index} aria-labelledby={headingId} className={index > 0 ? "border-t border-line pt-4" : undefined}>
            <h3 id={headingId} className="mb-3 text-sm font-medium text-ink">
              {group.title}
            </h3>
            {lists}
          </section>
        );
      })}
    </div>
  );
}
