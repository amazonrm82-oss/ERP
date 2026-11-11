import { describe, expect, it } from "vitest";

import { logRecord } from "@/lib/log";
import { DAMAGED_ORDER_PDF_MESSAGE, DAMAGED_PDF_MESSAGE, DAMAGED_SIGNATURE_PDF_MESSAGE, damagedPdf } from "@/features/quotes/pdf-fingerprint";

const ID = "11111111-1111-4111-8111-111111111111";

// RVW-86: a damaged server-written PDF is logged and answered by what it is: quote, order or signed document.
describe("damaged server PDF (RVW-86)", () => {
  it("names the kind and the message of each subject", () => {
    expect(damagedPdf({ order_id: null, signature_document_id: null })).toEqual({ kind: "quote", message: DAMAGED_PDF_MESSAGE });
    expect(damagedPdf({ order_id: ID, signature_document_id: null })).toEqual({ kind: "order", message: DAMAGED_ORDER_PDF_MESSAGE });
    expect(damagedPdf({ order_id: null, signature_document_id: ID })).toEqual({ kind: "signature", message: DAMAGED_SIGNATURE_PDF_MESSAGE });
    expect(DAMAGED_SIGNATURE_PDF_MESSAGE).toBe("קובץ ה-PDF של המסמך החתום פגום ולכן לא נפתח. פנו לתמיכה");
  });

  it("the log line keeps the signature kind", () => {
    const line = logRecord("error", "files.pdf_fingerprint_mismatch", { kind: damagedPdf({ order_id: null, signature_document_id: ID }).kind });
    expect(line.kind).toBe("signature");
  });
});
