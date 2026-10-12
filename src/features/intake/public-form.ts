import "server-only";

import { isFieldType } from "@/features/custom-fields/types";
import type { Json } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { createServiceClient } from "@/lib/supabase/service";

import { FORM_EXCLUDED_TYPES, INTAKE_FIELD_LABELS, isIntakeField, parseFieldsConfig } from "./fields";
import type { PublicField } from "./public-validate";

export type PublicForm = { title: string; intro: string | null; submitLabel: string; fields: PublicField[] };

type ServiceClient = NonNullable<ReturnType<typeof createServiceClient>>;

function isObject(value: unknown): value is Record<string, Json | undefined> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The reply of public.intake_form() as the hosted form's fields (built-in labels added here). */
export function publicFormFrom(data: Json): PublicForm | null {
  if (!isObject(data)) {
    return null;
  }
  const raw = Array.isArray(data.fields) ? data.fields : [];
  const config = parseFieldsConfig(raw);
  const byKey = new Map(raw.filter(isObject).map((item) => [item.key, item]));
  const fields: PublicField[] = [];
  for (const field of config) {
    // a condition on a field that is not on the form (gone, switched off) hides this one for good
    if (field.showIf && !fields.some((shown) => shown.key === field.showIf?.field)) {
      continue;
    }
    if (isIntakeField(field.key)) {
      fields.push({ ...field, label: INTAKE_FIELD_LABELS[field.key], custom: null });
      continue;
    }
    const item = byKey.get(field.key);
    const type = typeof item?.type === "string" ? item.type : "";
    if (!item || !isFieldType(type) || FORM_EXCLUDED_TYPES.includes(type) || typeof item.label !== "string") {
      continue;
    }
    const options = Array.isArray(item.options) ? item.options.filter((o): o is string => typeof o === "string") : [];
    fields.push({ ...field, label: item.label, custom: { type, label: item.label, options } });
  }
  return {
    title: typeof data.title === "string" ? data.title : "",
    intro: typeof data.intro === "string" && data.intro !== "" ? data.intro : null,
    submitLabel: typeof data.submit_label === "string" && data.submit_label.trim() !== "" ? data.submit_label : "שליחת הפרטים",
    fields,
  };
}

/** The form by its public token, through public.intake_form() (display settings only). */
export async function readPublicForm(service: ServiceClient, token: string): Promise<PublicForm | null> {
  const data = must(await service.rpc("intake_form", { p_token: token }), "intake_form");
  return publicFormFrom(data);
}

/**
 * What the hosted form shows, by its public token. Only display settings are
 * read; nothing about the organization or its data leaves the server.
 */
export async function getPublicForm(token: string): Promise<PublicForm | null | "not-configured"> {
  if (!/^[0-9a-f]{32}$/.test(token)) {
    return null;
  }
  const service = createServiceClient();
  if (!service) {
    return "not-configured";
  }
  return readPublicForm(service, token);
}
