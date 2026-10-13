import "server-only";

import { isHexColor } from "@/features/branding/color";
import { builtWithVisible } from "@/features/built-with/visibility";
import { isLogoPath } from "@/features/branding/logo";
import { isFieldType } from "@/features/custom-fields/types";
import type { Json } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { createServiceClient } from "@/lib/supabase/service";

import { callbackOfferFrom, type CallbackOffer } from "./callback";
import { FORM_EXCLUDED_TYPES, INTAKE_FIELD_LABELS, isIntakeField, parseFieldsConfig } from "./fields";
import type { PublicField } from "./public-validate";
import { whatsappChatUrl } from "./whatsapp";

export type PublicForm = {
  title: string;
  intro: string | null;
  submitLabel: string;
  fields: PublicField[];
  // FLD-04: the business's logo (object name in the public bucket) and main colour, or null
  brand: { logoPath: string | null; color: string | null };
  // CAP-05: the thank-you state's WhatsApp chat link (wa.me), or null for no button
  thanks: { whatsappUrl: string | null };
  // SPD-05: the form asks when to call back: what it offers now (database rules), or null when it does not ask
  callback: CallbackOffer | null;
};

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
    brand: {
      logoPath: isObject(data.brand) && isLogoPath(data.brand.logo) ? data.brand.logo : null,
      color: isObject(data.brand) && isHexColor(data.brand.color) ? data.brand.color : null,
    },
    thanks: {
      whatsappUrl: isObject(data.thanks)
        ? whatsappChatUrl(
            typeof data.thanks.whatsapp === "string" ? data.thanks.whatsapp : null,
            typeof data.thanks.whatsapp_text === "string" ? data.thanks.whatsapp_text : null,
          )
        : null,
    },
    callback: callbackOfferFrom(data.callback),
  };
}

/** The form by its public token, through public.intake_form() (display settings only). */
export async function readPublicForm(service: ServiceClient, token: string): Promise<PublicForm | null> {
  const data = must(await service.rpc("intake_form", { p_token: token }), "intake_form");
  return publicFormFrom(data);
}

/**
 * What the hosted form shows, by its public token. Only display settings are
 * read, plus the organization's logo and colour (FLD-04) and, when the form
 * turns it on, the WhatsApp number of the thank-you page (CAP-05); nothing else about
 * the organization or its data leaves the server.
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

/**
 * Whether the hosted form shows the "נבנה ב-Mexuz" line (FLD-04), through
 * public.intake_form_built_with(): true unless the business's plan or override
 * turns remove_built_with on. Anything but true (form not found, no service key)
 * hides the line.
 */
export async function getPublicFormBuiltWith(token: string): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/.test(token)) {
    return false;
  }
  const service = createServiceClient();
  if (!service) {
    return false;
  }
  const data = must(await service.rpc("intake_form_built_with", { p_token: token }), "intake_form_built_with");
  return builtWithVisible(data);
}
