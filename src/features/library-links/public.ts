import { z } from "zod";

import { qrLinkHost, type QrExternal } from "@/features/qr-codes/redirect";
import { qrTargetUrlOk } from "@/features/qr-codes/target-url";

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
    // BIZ-03's emergency switch: the platform blocks the business's outside links (no url then)
    external_blocked: z.boolean().optional(),
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
  // a link item's https address (null while the platform blocks the business's outside links)
  url: string | null;
  // a link item whose site the platform switched off: the page shows no button
  externalBlocked: boolean;
  file: { name: string; mimeType: string; sizeBytes: number } | null;
};

/** The database's answer, shaped for the page; null when it is not the expected shape. */
export function publicLibraryItemFrom(data: unknown): PublicLibraryItem | null {
  const parsed = answerSchema.safeParse(data);
  if (!parsed.success) return null;
  const a = parsed.data;
  const externalBlocked = a.item.kind === "link" && a.item.external_blocked === true;
  if (a.item.kind === "link" && !a.item.url && !externalBlocked) return null;
  if (a.item.kind === "file" && !a.item.file) return null;
  return {
    business: a.business,
    logoPath: a.brand.logo,
    color: a.brand.color,
    builtWith: a.built_with,
    kind: a.item.kind,
    title: a.item.title,
    description: a.item.description,
    url: a.item.kind === "link" && !externalBlocked ? a.item.url : null,
    externalBlocked,
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

/**
 * LIB-02 (owner (293) ב, 12 November 2026): a link item never opens straight away. Its button leads to this route, which shows
 * the page before an outside site of BIZ-03 ("אתם עוברים לאתר …"), with the stored link only.
 */
export const publicLibraryGoPath = (token: string) => `/f/lib/${token}/go`;

const goSchema = z.object({ url: z.string(), business: z.string() });

export type PublicLibraryGoAnswer = { kind: "go"; view: QrExternal } | { kind: "rate-limited" };

/**
 * public.library_link_public_link's answer as the page before the site: the stored https link unchanged (it must pass the
 * rule the database stored it by, qrTargetUrlOk), its host as stored and, for punycode, in its own letters only when every
 * label is safe to show (BIZ-03's rule), and the business's display name. Null when malformed.
 */
export function publicLibraryGoFrom(data: unknown): PublicLibraryGoAnswer | null {
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return { kind: "rate-limited" };
  }
  const parsed = goSchema.safeParse(data);
  if (!parsed.success) return null;
  const business = parsed.data.business.trim();
  if (!qrTargetUrlOk(parsed.data.url) || business === "") return null;
  return { kind: "go", view: { href: parsed.data.url, ...qrLinkHost(parsed.data.url), business } };
}

/** The host a link item opens, for the line under its button. */
export function linkHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
