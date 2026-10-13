// FLD-04: the business logo lives in the PUBLIC bucket "org-logos", one object
// per logo, named "<organization id>/<random uuid>" (see migration org_branding).
// It is shown on the business's public pages to people who are not signed in,
// so it is served by its public URL; only owners and admins write to the folder.

import { getSupabaseEnv } from "@/lib/env";

export const LOGOS_BUCKET = "org-logos";
export const LOGO_MAX_BYTES = 1024 * 1024;
// no SVG: an SVG file can carry script
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATH = new RegExp(`^(${UUID})/${UUID}$`);

/** True when the path is a logo object in this organization's folder. */
export function isOrgLogoPath(path: unknown, orgId: string): path is string {
  if (typeof path !== "string") return false;
  const match = PATH.exec(path);
  return match !== null && match[1] === orgId;
}

/** Any well-formed logo path (the organization is checked where the path came from). */
export function isLogoPath(path: unknown): path is string {
  return typeof path === "string" && PATH.test(path);
}

/** A Hebrew message when the picked file cannot be a logo, else null. */
export function logoFileProblem(file: { type: string; size: number }): string | null {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return "אפשר להעלות לוגו מסוג PNG, JPG או WebP.";
  if (file.size > LOGO_MAX_BYTES) return "הקובץ גדול מדי. אפשר עד 1 MB.";
  if (file.size === 0) return "הקובץ ריק.";
  return null;
}

/** The public address of a logo, or null when the path is not a logo path or Supabase is not configured. */
export function logoPublicUrl(path: string | null | undefined, supabaseUrl: string | null = getSupabaseEnv()?.url ?? null): string | null {
  if (!isLogoPath(path) || !supabaseUrl) return null;
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${LOGOS_BUCKET}/${path}`;
}
