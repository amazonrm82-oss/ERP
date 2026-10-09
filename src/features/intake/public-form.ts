import "server-only";

import { createServiceClient } from "@/lib/supabase/service";

import { parseFieldsConfig, type FormFieldConfig } from "./fields";
import { must } from "@/lib/db-read";

export type PublicForm = { title: string; intro: string | null; submitLabel: string; fields: FormFieldConfig[] };

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
  const data = must(await service
    .from("forms")
    .select("name, title, intro, submit_label, fields, is_active")
    .eq("token", token)
    .eq("kind", "form")
    .maybeSingle(), "forms");
  if (!data || !data.is_active) {
    return null;
  }
  return {
    title: data.title || data.name,
    intro: data.intro,
    submitLabel: data.submit_label || "שליחת הפרטים",
    fields: parseFieldsConfig(data.fields),
  };
}
