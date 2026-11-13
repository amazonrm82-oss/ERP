import { z } from "zod";

import { FIELD_TYPES, type FieldType } from "@/features/custom-fields/types";
import type { Json } from "@/lib/database.types";

// BIZ-05: the customer's page of a prefill form, from public.prefill_public(token, ip_hash) (service_role only). The answer
// holds no ids: the business's display name, logo and colour, the built-with line, the privacy notice's contact, the
// template's title and intro, and the template's fields with the record's current values.

/** The customer's link: 64 base64url characters (only its SHA-256 is kept). */
export const PREFILL_LINK_TOKEN = /^[A-Za-z0-9_-]{64}$/;

const text = z.string().nullable();

const business = {
  business: z.string(),
  brand: z.object({ logo: text, color: text }),
  built_with: z.boolean(),
};

const fieldSchema = z.object({
  key: z.string().regex(/^(cf:[a-z][a-z0-9_]{0,39}|[a-z_]{1,20})$/),
  label: z.string(),
  type: z.string(),
  options: z.array(z.string()).catch([]),
  help: text,
  required: z.boolean(),
  read_only: z.boolean(),
  value: z.custom<Json>((v) => v === null || ["string", "number", "boolean"].includes(typeof v) || Array.isArray(v)),
});

const openSchema = z.object({
  status: z.literal("open"),
  ...business,
  title: z.string(),
  intro: text,
  notice: z.object({ name: text.optional(), email: text.optional(), phone: text.optional() }).nullable(),
  fields: z.array(fieldSchema),
});

const doneSchema = z.object({ status: z.literal("done"), ...business });

export type PrefillField = {
  key: string;
  label: string;
  type: FieldType | "text";
  options: string[];
  help: string | null;
  required: boolean;
  readOnly: boolean;
  value: Json;
};

type PrefillBusiness = { business: string; logoPath: string | null; color: string | null; builtWith: boolean };

export type PublicPrefill =
  | (PrefillBusiness & {
      status: "open";
      title: string;
      intro: string | null;
      notice: { business: string | null; email: string | null; phone: string | null };
      fields: PrefillField[];
    })
  | (PrefillBusiness & { status: "done" });

const fieldType = (type: string): FieldType | "text" => ((FIELD_TYPES as readonly string[]).includes(type) ? (type as FieldType) : "text");

/** The database's answer, shaped for the page; null when it is not the expected shape. */
export function publicPrefillFrom(data: unknown): PublicPrefill | null {
  const done = doneSchema.safeParse(data);
  if (done.success) {
    const a = done.data;
    return { status: "done", business: a.business, logoPath: a.brand.logo, color: a.brand.color, builtWith: a.built_with };
  }
  const parsed = openSchema.safeParse(data);
  if (!parsed.success) return null;
  const a = parsed.data;
  return {
    status: "open",
    business: a.business,
    logoPath: a.brand.logo,
    color: a.brand.color,
    builtWith: a.built_with,
    title: a.title,
    intro: a.intro,
    notice: { business: a.notice?.name ?? a.business, email: a.notice?.email ?? null, phone: a.notice?.phone ?? null },
    fields: a.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: fieldType(f.type),
      options: f.options,
      help: f.help,
      required: f.required,
      readOnly: f.read_only,
      value: f.value,
    })),
  };
}

/** The input a submission's refusal is about (the fixed messages of public.prefill_public_submit), else undefined. */
export function prefillWrongField(error: string): string | undefined {
  if (error === "invalid email address") return "email";
  if (error === "invalid phone") return "phone";
  if (error === "invalid birth date") return "birth_date";
  const custom = /^invalid custom field: ([a-z][a-z0-9_]{0,39})$/.exec(error);
  if (custom) return `cf:${custom[1]}`;
  const other = /^(?:invalid field|required field missing): (\S+)$/.exec(error);
  return other?.[1];
}
