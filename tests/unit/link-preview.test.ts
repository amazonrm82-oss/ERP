import { beforeEach, describe, expect, it, vi } from "vitest";

import { businessPreview, genericPreview, linkPreviewMetadata, PREVIEW_DESCRIPTION_MAX, PREVIEW_TEXTS, PREVIEW_TITLE_MAX, previewText } from "@/lib/link-preview";

// WAB-05: a customer page opened from a WhatsApp link shows a preview with the business's name and logo, and nothing about the
// customer. The page and its preview read the page's public function ONCE per request: several of them count views, and the
// quote's first view tells its owner.

const ORG = "11111111-2222-4333-8444-555555555555";
const LOGO = `${ORG}/66666666-7777-4888-9999-aaaaaaaaaaaa`;
const SUPABASE = "https://example.supabase.co";
const LOGO_URL = `${SUPABASE}/storage/v1/object/public/org-logos/${LOGO}`;

function flat(value: unknown): string {
  return JSON.stringify(value);
}

describe("preview texts", () => {
  it("collapses spaces and cuts long text at a word with an ellipsis", () => {
    expect(previewText("  שלום \n  עולם ", 40)).toBe("שלום עולם");
    const long = "מילה ".repeat(60);
    const cut = previewText(long, 50);
    expect(Array.from(cut).length).toBeLessThanOrEqual(50);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toContain("  ");
    expect(previewText(null, 10)).toBe("");
  });
});

describe("the preview metadata (WAB-05)", () => {
  it("names the business and what the page is, in Hebrew, with the logo", () => {
    const m = businessPreview({ ...PREVIEW_TEXTS.quote, business: "נגריית הצפון", logoUrl: LOGO_URL });
    expect(m.title).toEqual({ absolute: "הצעת מחיר מאת נגריית הצפון" });
    expect(m.openGraph).toMatchObject({
      type: "website",
      locale: "he_IL",
      title: "הצעת מחיר מאת נגריית הצפון",
      siteName: "נגריית הצפון",
      description: PREVIEW_TEXTS.quote.description,
      images: [{ url: LOGO_URL, alt: "הלוגו של נגריית הצפון" }],
    });
    expect(m.twitter).toMatchObject({ card: "summary", title: "הצעת מחיר מאת נגריית הצפון", images: [{ url: LOGO_URL }] });
    expect(m.robots).toEqual({ index: false, follow: false });
  });

  it("has no image without a logo: never the app's own share image", () => {
    const m = businessPreview({ ...PREVIEW_TEXTS.booking, business: "סטודיו", logoUrl: null });
    expect(m.openGraph?.images).toEqual([]);
    expect(m.twitter?.images).toEqual([]);
  });

  it("keeps the referrer rule of the quote and order pages", () => {
    expect(businessPreview({ ...PREVIEW_TEXTS.order, business: "עסק", logoUrl: null }, { referrer: "no-referrer" }).referrer).toBe("no-referrer");
    expect(businessPreview({ ...PREVIEW_TEXTS.order, business: "עסק", logoUrl: null }).referrer).toBeUndefined();
  });

  it("a generic preview names no business and keeps the root title template", () => {
    const m = genericPreview(PREVIEW_TEXTS.quote.what, PREVIEW_TEXTS.quote.description);
    expect(m.title).toBe("הצעת מחיר");
    expect(m.openGraph).not.toHaveProperty("siteName");
    expect(m.openGraph?.images).toEqual([]);
  });

  it("caps title and description lengths", () => {
    const m = linkPreviewMetadata({ title: "א".repeat(200), description: "ב".repeat(400), business: "ג".repeat(200), logoUrl: null });
    expect(Array.from(m.openGraph?.title as string).length).toBe(PREVIEW_TITLE_MAX);
    expect(Array.from(m.description as string).length).toBe(PREVIEW_DESCRIPTION_MAX);
  });

  it("every page text is Hebrew and short", () => {
    for (const t of Object.values(PREVIEW_TEXTS)) {
      expect(t.what).toMatch(/[֐-׿]/);
      expect(t.description).toMatch(/[֐-׿]/);
      expect(Array.from(t.description).length).toBeLessThanOrEqual(PREVIEW_DESCRIPTION_MAX);
    }
  });
});

// --- one read per request ----------------------------------------------------------------------------------------------

const calls: string[] = [];
const replies: Record<string, { data: unknown; error: unknown }> = {};

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  // one request: React's cache() memoizes per request on the server; the unit environment loads the client build, where it
  // does not, so the test gives it a plain memo (the request) that is reset before each page
  const cache = <A extends unknown[], R>(fn: (...args: A) => R) => {
    return (...args: A): R => {
      const key = JSON.stringify(args);
      if (!requestMemo.has(fn)) requestMemo.set(fn, new Map());
      const memo = requestMemo.get(fn)!;
      if (!memo.has(key)) memo.set(key, fn(...args));
      return memo.get(key) as R;
    };
  };
  return { ...actual, cache };
});
const requestMemo = new Map<unknown, Map<string, unknown>>();

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    rpc: async (name: string) => {
      calls.push(name);
      return replies[name] ?? { data: null, error: { code: "P0002", message: "not found" } };
    },
  }),
}));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, getSupabaseEnv: () => ({ url: SUPABASE, anonKey: "anon" }) };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "WhatsApp/2.24" }),
  cookies: async () => ({ get: () => undefined }),
}));

// a page's token as its own route checks it: 32 hex (form, booking, card) or 64 (quote, order, booking manage link)
const TOKEN32 = "0123456789abcdef0123456789abcdef";
const TOKEN64 = TOKEN32 + TOKEN32;

type PageModule = {
  default: (props: never) => Promise<unknown>;
  generateMetadata: (props: never) => Promise<import("next").Metadata>;
};

async function render(mod: PageModule, search: Record<string, string> = {}, token = TOKEN32) {
  const props = { params: Promise.resolve({ token }), searchParams: Promise.resolve(search) } as never;
  // Next runs the two side by side in one request
  const [metadata] = await Promise.all([mod.generateMetadata(props), mod.default(props)]);
  return metadata;
}

describe("the page and its preview read once per request (WAB-05)", () => {
  beforeEach(() => {
    calls.length = 0;
    requestMemo.clear();
    for (const key of Object.keys(replies)) delete replies[key];
  });

  it("quote: quote_public (which counts the view and tells the owner) runs once; no customer data in the preview", async () => {
    replies.quote_public = {
      data: {
        status_page: {
          state: "expired",
          number: "Q-1001",
          title: "שיפוץ דירת משפחת כהן",
          valid_until: "2026-10-01",
          business: "נגריית הצפון",
          logo: LOGO,
          color: "#112233",
          phone: "03-5555555",
          replaced: null,
          draft_version: false,
        },
      },
      error: null,
    };
    const m = await render((await import("@/app/f/quote/[token]/page")) as unknown as PageModule, {}, TOKEN64);
    expect(calls).toEqual(["quote_public"]);
    expect(m.openGraph).toMatchObject({ title: "הצעת מחיר מאת נגריית הצפון", images: [{ url: LOGO_URL }] });
    expect(m.referrer).toBe("no-referrer");
    const text = flat(m);
    for (const secret of ["Q-1001", "כהן", "03-5555555", "2026-10-01"]) expect(text).not.toContain(secret);
  });

  it("quote: a link that is not found reads once and gets a generic preview", async () => {
    const m = await render((await import("@/app/f/quote/[token]/page")) as unknown as PageModule, {}, TOKEN64);
    expect(calls).toEqual(["quote_public"]);
    expect(m.title).toBe("הצעת מחיר");
    expect(m.referrer).toBe("no-referrer");
  });

  it("order: order_public runs once", async () => {
    replies.order_public = {
      data: { status_page: { state: "cancelled", number: "ORD-7", business: "העסק", logo: LOGO, color: null, phone: "03-1" } },
      error: null,
    };
    const m = await render((await import("@/app/f/order/[token]/page")) as unknown as PageModule, {}, TOKEN64);
    expect(calls).toEqual(["order_public"]);
    expect(m.openGraph).toMatchObject({ title: "אישור הזמנה מאת העסק", images: [{ url: LOGO_URL }] });
    expect(flat(m)).not.toContain("ORD-7");
  });

  it("booking page: booking_page_public runs once, with the same week as the page", async () => {
    replies.booking_page_public = {
      data: {
        title: "פגישת ייעוץ",
        intro: null,
        business: "סטודיו דנה",
        rep: "דנה",
        brand: { logo: null, color: null },
        built_with: false,
        time_zone: "Asia/Jerusalem",
        meeting: { name: "ייעוץ", duration_minutes: 45, format: "video", location: null },
        questions: [],
        today: "2026-10-27",
        last_day: "2026-11-30",
        from: "2026-11-02",
        slots: [],
      },
      error: null,
    };
    const m = await render((await import("@/app/f/book/[token]/page")) as unknown as PageModule, { from: "2026-11-02" });
    expect(calls).toEqual(["booking_page_public"]);
    expect(m.openGraph).toMatchObject({ title: "קביעת תור אצל סטודיו דנה", images: [] });
    expect(m.description).toContain("פגישת ייעוץ");
  });

  it("booking manage link: booking_manage_public runs once", async () => {
    await render((await import("@/app/f/book/manage/[token]/page")) as unknown as PageModule, {}, TOKEN64);
    expect(calls).toEqual(["booking_manage_public"]);
  });

  it("business card: business_card_public runs once; the preview carries the rep's public name and the business", async () => {
    replies.business_card_public = {
      data: { name: "דנה לוי", business: "סטודיו דנה", job_title: "מעצבת", brand: { logo: LOGO, color: null }, phone: "050-1234567", email: "d@example.test", form: false },
      error: null,
    };
    const m = await render((await import("@/app/f/card/[token]/page")) as unknown as PageModule);
    expect(calls).toEqual(["business_card_public"]);
    expect(m.openGraph).toMatchObject({ title: "כרטיס ביקור של דנה לוי · סטודיו דנה", siteName: "סטודיו דנה", images: [{ url: LOGO_URL }] });
    expect(flat(m)).not.toContain("050-1234567");
  });

  it("web form: intake_form runs once", async () => {
    replies.intake_form = { data: { inactive: true }, error: null };
    await render((await import("@/app/f/[token]/page")) as unknown as PageModule);
    expect(calls).toEqual(["intake_form"]);
  });
});
