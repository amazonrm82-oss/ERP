import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PdfDocument } from "@/features/pdf/document";
import type { QuoteDocumentData } from "@/features/quotes/design-server";
import type { Quote } from "@/features/quotes/queries";

// Review M1 of 021190 (owner (175) ג): both remake paths of storeQuotePdf render the state as sent when the quote has one; a
// failed or unreadable read of it, or a quote that has one but whose read came back empty, makes nothing (the credit is
// kept); a first PDF is still the live quote. The database, the renderer and the store are replaced here.

const rendered: PdfDocument[] = [];
const documentQuotes: Quote[] = [];
const write = vi.fn(async () => ({ ok: true as const, fileId: "f-new" }));

vi.mock("@/features/pdf/render", () => ({
  renderPdf: async (doc: PdfDocument) => {
    rendered.push(doc);
    return new Uint8Array([1]);
  },
}));
vi.mock("@/features/pdf/logo", () => ({ loadPdfLogo: async () => null }));
vi.mock("@/features/quotes/pdf-store-server", () => ({ writeQuotePdfAsServer: () => write() }));
vi.mock("@/features/quotes/signed-pdf-server", () => ({ renderSignedQuotePdf: vi.fn(), writeSignedQuotePdfAsServer: vi.fn() }));
vi.mock("@/features/quotes/queries", () => ({ getQuoteDecision: async () => ({ sentTotalAgorot: 11800, acceptedTotalAgorot: 17700, optionalChosen: 1 }) }));
vi.mock("@/features/quotes/design-server", () => ({
  getQuoteDocumentData: async (_org: string, quote: Quote): Promise<QuoteDocumentData> => {
    documentQuotes.push(quote);
    return {
      design: { headerText: null, footerText: null, showLogo: false, showBusinessDetails: false, showBankDetailsQuote: false, showBankDetailsOrder: false, showBankDetailsStatement: false, accentColor: null },
      color: null,
      logoUrl: null,
      business: { name: "העסק", taxId: null, address: null, phone: null, email: null },
      customer: null,
      quote,
      lines: [],
      schedule: [],
    } as unknown as QuoteDocumentData;
  },
}));

const { remakeLegacyQuotePdf, storeQuotePdf } = await import("@/features/quotes/pdf-server");

const SENT = { vat_rate_bp: 1800, subtotal_agorot: 10000, discount_total_agorot: 0, net_total_agorot: 10000, vat_agorot: 1800, total_agorot: 11800, optional_lines: [] };
const NOT_MADE = { ok: false, message: "קובץ ה-PDF לא נשמר. נסו שוב בעוד רגע." };

type Rpc = { data: unknown; error: { message: string } | null };
type FileRow = { id: string; name: string; unconfirmed_since: null; sha256: string | null };

function client(rpcs: Record<string, Rpc>, file: FileRow | null = null) {
  const asked: string[] = [];
  const from = (table: string) => {
    const result = table === "files" ? { data: file, error: null } : { data: { name: "העסק", timezone: "Asia/Jerusalem" }, error: null };
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is"]) self[m] = () => self;
    self.maybeSingle = async () => result;
    return self;
  };
  const rpc = async (name: string) => {
    asked.push(name);
    return rpcs[name] ?? { data: null, error: null };
  };
  return { asked, rpc, from };
}

const quote = (extra: Partial<Quote> = {}) =>
  ({
    id: "q1",
    title: "הצעה",
    status: "accepted",
    cancelledFrom: null,
    numberDisplay: "Q-7",
    subtotalAgorot: 15000,
    discountTotalAgorot: 0,
    netTotalAgorot: 15000,
    vatAgorot: 2700,
    totalAgorot: 17700,
    vatRateBp: 1800,
    ...extra,
  }) as unknown as Quote;

const ok = (data: unknown): Rpc => ({ data, error: null });
const boom: Rpc = { data: null, error: { message: "boom" } };
const remakeRpcs = (sent: Rpc, has: Rpc = ok(true)) => ({
  recipient_pdf_remake_pending: ok(true),
  quote_pdf_recipient_remake_allowed: ok(true),
  quote_sent_state: sent,
  quote_has_sent_state: has,
});

beforeEach(() => {
  rendered.length = 0;
  documentQuotes.length = 0;
  write.mockClear();
});

describe("remakes of the PDF as sent read the state as sent (review M1)", () => {
  it("the recipient-erasure remake renders the snapshot, marked as sent", async () => {
    const result = await storeQuotePdf(client(remakeRpcs(ok(SENT))) as never, "o1", quote(), "u1");
    expect(result).toEqual({ ok: true, fileId: "f-new" });
    expect(rendered).toHaveLength(1);
    expect(rendered[0].footerNote).toMatch(/, כפי שנשלח$/);
    expect(documentQuotes[0].totalAgorot).toBe(11800);
  });

  it("owner (176) ב: a snapshot equal to the quote today gives the plain remake line, without the mark", async () => {
    const today = { subtotalAgorot: 10000, netTotalAgorot: 10000, vatAgorot: 1800, totalAgorot: 11800 } as Partial<Quote>;
    expect((await storeQuotePdf(client(remakeRpcs(ok(SENT))) as never, "o1", quote(today), "u1")).ok).toBe(true);
    const legacy = client({ quote_pdf_remake_allowed: ok(true), quote_sent_state: ok(SENT) }, { id: "f-old", name: "a.pdf", unconfirmed_since: null, sha256: null });
    await remakeLegacyQuotePdf(legacy as never, "o1", quote(today), "u1");
    expect(rendered).toHaveLength(2);
    for (const doc of rendered) {
      expect(doc.footerNote).toMatch(/^נוצר מחדש ב-\d{2}\.\d{2}\.\d{4} מהנתונים השמורים$/);
    }
    // only the rate differing brings the mark back
    rendered.length = 0;
    await storeQuotePdf(client(remakeRpcs(ok(SENT))) as never, "o1", quote({ ...today, vatRateBp: 1700 }), "u1");
    expect(rendered[0].footerNote).toMatch(/, כפי שנשלח$/);
  });

  it("the legacy remake renders the snapshot too", async () => {
    const legacy = client({ quote_pdf_remake_allowed: ok(true), quote_sent_state: ok(SENT) }, { id: "f-old", name: "a.pdf", unconfirmed_since: null, sha256: null });
    // the mock store answers ok, the file read back still has no fingerprint: false, but the render happened
    expect(await remakeLegacyQuotePdf(legacy as never, "o1", quote(), "u1")).toBe(false);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].footerNote).toMatch(/, כפי שנשלח$/);
    expect(documentQuotes[0].totalAgorot).toBe(11800);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("an error, an unreadable answer, or an empty read of a quote that has one makes nothing", async () => {
    for (const rpcs of [remakeRpcs(boom), remakeRpcs(ok({ total_agorot: "x" })), remakeRpcs(ok(null), ok(true)), remakeRpcs(ok(null), boom)]) {
      expect(await storeQuotePdf(client(rpcs) as never, "o1", quote(), "u1")).toEqual(NOT_MADE);
    }
    for (const sent of [boom, ok({ total_agorot: "x" })]) {
      const legacy = client({ quote_pdf_remake_allowed: ok(true), quote_sent_state: sent });
      expect(await remakeLegacyQuotePdf(legacy as never, "o1", quote(), "u1")).toBe(false);
    }
    expect(rendered).toHaveLength(0);
    expect(write).not.toHaveBeenCalled();
  });

  it("a quote without one (sent before 021190) keeps 021187's rule, also when cancelled after acceptance", async () => {
    for (const q of [quote(), quote({ status: "cancelled", cancelledFrom: "accepted" } as Partial<Quote>)]) {
      rendered.length = 0;
      expect((await storeQuotePdf(client(remakeRpcs(ok(null), ok(false))) as never, "o1", q, "u1")).ok).toBe(true);
      expect(rendered[0].footerNote).toMatch(/, לפי מה שאושר$/);
    }
  });

  it("a first PDF is the live quote and never asks for the snapshot", async () => {
    const supabase = client({ recipient_pdf_remake_pending: ok(false), quote_pdf_allowed: ok(true) });
    expect((await storeQuotePdf(supabase as never, "o1", quote({ status: "sent" }), "u1")).ok).toBe(true);
    expect(supabase.asked).not.toContain("quote_sent_state");
    expect(rendered[0].footerNote).toBeNull();
    expect(documentQuotes[0].totalAgorot).toBe(17700);
  });
});
