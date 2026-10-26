import "server-only";

import { LOGO_MAX_BYTES } from "@/features/branding/logo";

import type { PdfLogo } from "./document";

/** What the file's first bytes say it is: PDF documents take PNG and JPEG images (a WebP logo is left out). */
export function logoKind(bytes: Uint8Array): PdfLogo["kind"] | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/**
 * The business logo for a PDF, fetched from its public address in the org-logos bucket (FLD-04; the address comes from
 * logoPublicUrl, never from a person). Null when there is none, it is not PNG or JPEG, it is over the logo size limit, or it
 * does not arrive within 5 seconds: the document is then made without it.
 */
export async function loadPdfLogo(url: string | null): Promise<PdfLogo | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), cache: "no-store" });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) return null;
    const kind = logoKind(bytes);
    return kind ? { data: bytes, kind } : null;
  } catch {
    return null;
  }
}
