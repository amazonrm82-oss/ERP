// Owner (337) א, 12 November 2026: a plan whose monthly PDF quota is zero (the free plan) makes no report or order PDF. Every
// PDF button for reports and orders then shows this line instead of a quota error; the server still refuses
// (app.pdf_take, limit:max_pdf_per_month). Quote PDFs are never counted, so they are not affected.

export const PDF_FROM_PERSONAL = "זמין מחבילת אישית";

/** True only for a quota of exactly zero: no cap (null) and a quota that is merely used up are not this case. */
export function pdfQuotaZero(limit: unknown): boolean {
  return limit === 0 || limit === "0";
}
