import { z } from "zod";

// LIB-02: the customer's page of a library item sent by a tracked link, from public.library_link_public(token, ip_hash)
// (service_role only). The answer holds no ids: the business's display name, logo and colour, the built-with line, and the
// item's kind, title, description and its link (a link item) or its file's name, type and size (a file item).

/** The customer's link: 64 base64url characters (only its SHA-256 is kept). */
export const LIBRARY_LINK_TOKEN = /^[A-Za-z0-9_-]{64}$/;

export const publicLibraryPath = (token: string) => `/f/lib/${token}`;

/** The item's file, through a one-minute signed link made for this request. */
export const publicLibraryFilePath = (token: string) => `/api/forms/lib/${token}/file`;

const text = z.string().nullable();

const answerSchema = z.object({
  business: z.string(),
  brand: z.object({ logo: text, color: text }),
  built_with: z.boolean(),
  item: z.object({
    kind: z.enum(["link", "file"]),
    title: z.string(),
    description: text,
    url: text,
    file: z.object({ name: z.string(), mime_type: z.string(), size_bytes: z.coerce.number().int().nonnegative() }).nullable(),
  }),
});

export type PublicLibraryItem = {
  business: string;
  logoPath: string | null;
  color: string | null;
  builtWith: boolean;
  kind: "link" | "file";
  title: string;
  description: string | null;
  // a link item's https address
  url: string | null;
  file: { name: string; mimeType: string; sizeBytes: number } | null;
};

/** The database's answer, shaped for the page; null when it is not the expected shape. */
export function publicLibraryItemFrom(data: unknown): PublicLibraryItem | null {
  const parsed = answerSchema.safeParse(data);
  if (!parsed.success) return null;
  const a = parsed.data;
  if (a.item.kind === "link" && !a.item.url) return null;
  if (a.item.kind === "file" && !a.item.file) return null;
  return {
    business: a.business,
    logoPath: a.brand.logo,
    color: a.brand.color,
    builtWith: a.built_with,
    kind: a.item.kind,
    title: a.item.title,
    description: a.item.description,
    url: a.item.kind === "link" ? a.item.url : null,
    file: a.item.kind === "file" && a.item.file ? { name: a.item.file.name, mimeType: a.item.file.mime_type, sizeBytes: a.item.file.size_bytes } : null,
  };
}

const fileSchema = z.object({ path: z.string().min(1), name: z.string(), mime_type: z.string() });

export type PublicLibraryFileAnswer = { kind: "file"; path: string; name: string; mimeType: string } | { kind: "rate-limited" };

/** The file function's answer: the object's path, name and type (or rate-limited); null when malformed. */
export function publicLibraryFileFrom(data: unknown): PublicLibraryFileAnswer | null {
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return { kind: "rate-limited" };
  }
  const parsed = fileSchema.safeParse(data);
  if (!parsed.success) return null;
  return { kind: "file", path: parsed.data.path, name: parsed.data.name, mimeType: parsed.data.mime_type };
}

/** The host a link item opens, for the line under its button. */
export function linkHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
