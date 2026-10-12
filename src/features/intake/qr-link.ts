/**
 * What a form's QR code opens (CAP-03): the form's page, marked utm_source=qr
 * so leads from a sign or a flyer show where they came from (CAP-02).
 */
export function formQrUrl(pageUrl: string): string {
  return `${pageUrl}?utm_source=qr`;
}

/** A file name for the downloaded code, from the form's name (letters, digits and dashes). */
export function qrFileName(name: string): string {
  const slug = name
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `qr-${slug || "form"}`;
}
