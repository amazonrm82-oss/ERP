import { Detail } from "@/components/detail-list";

import type { CustomValues, FieldDefinition } from "../types";
import { displayCustomFields } from "../values";

/** Detail rows (inside a DetailList) for a record's active custom fields. */
export function CustomFieldDetails({ definitions, values }: { definitions: FieldDefinition[]; values: CustomValues }) {
  return (
    <>
      {displayCustomFields(definitions, values).map((field) => (
        <Detail
          key={field.key}
          label={field.label}
          ltr={field.ltr}
          value={
            field.href && field.text ? (
              <a href={field.href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-4">
                {field.text.replace(/^https?:\/\//, "")}
              </a>
            ) : (
              field.text
            )
          }
        />
      ))}
    </>
  );
}
