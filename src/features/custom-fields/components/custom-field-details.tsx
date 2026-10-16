import { Detail } from "@/components/detail-list";

import { fieldState } from "../conditions";
import type { CustomValues, FieldDefinition, FieldObject } from "../types";
import { displayCustomFields } from "../values";
import { customFieldValue } from "./custom-field-value";

type Props = {
  definitions: FieldDefinition[];
  values: CustomValues;
  // FLD-09: a field whose "show" condition does not hold is left out (its value is kept)
  objectType?: FieldObject;
  builtins?: Record<string, string | null>;
};

/** Detail rows (inside a DetailList) for a record's active custom fields. */
export function CustomFieldDetails({ definitions, values, objectType, builtins }: Props) {
  const conditionValues = { ...values, ...(builtins ?? {}) };
  const shown = definitions.filter((field) => fieldState(field, definitions, conditionValues, objectType).visible);
  return (
    <>
      {displayCustomFields(shown, values).map((field) => (
        <Detail
          key={field.key}
          label={field.label}
          ltr={field.ltr}
          value={customFieldValue(field)}
        />
      ))}
    </>
  );
}
