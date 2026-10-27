import type { Metadata } from "next";

// WAB-05: the preview a messaging app (WhatsApp, Telegram, Facebook, ...) draws for a link to a customer page: the
// business's name and logo and what the page is, nothing else. Every builder here takes only the business's public
// display fields, never the customer's name, a price, a number or a time, so a preview cannot carry them.
//
// The image is the business's logo from the public bucket (FLD-04), or none: the app's own share image is not a neutral
// default for a business's page (a business whose plan removes the "נבנה ב-Mexuz" line should not show Mexuz either).

export const PREVIEW_TITLE_MAX = 70;
export const PREVIEW_DESCRIPTION_MAX = 160;

/** One line, collapsed spaces, cut at a word boundary with "…" when longer than `max` code points. */
export function previewText(value: string | null | undefined, max: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export type LinkPreview = {
  /** the preview's title: what the page is, with the business's name when known */
  title: string;
  description: string;
  /** the business's display name (og:site_name), or null on a generic preview */
  business: string | null;
  /** the business's logo, an absolute public URL, or null */
  logoUrl: string | null;
};

type PageOptions = {
  /** QUO-14: quote and order pages never send their secret address in a Referer header */
  referrer?: Metadata["referrer"];
  /** generic previews keep the root title template ("… | Mexuz"); a business's page does not */
  absoluteTitle?: boolean;
};

/** Next metadata for a customer page: title, description, Open Graph and Twitter card, never indexed. */
export function linkPreviewMetadata(preview: LinkPreview, options: PageOptions = {}): Metadata {
  const title = previewText(preview.title, PREVIEW_TITLE_MAX);
  const description = previewText(preview.description, PREVIEW_DESCRIPTION_MAX);
  const business = preview.business ? previewText(preview.business, PREVIEW_TITLE_MAX) : null;
  const images = preview.logoUrl ? [{ url: preview.logoUrl, alt: business ? `הלוגו של ${business}` : "לוגו העסק" }] : [];
  return {
    title: options.absoluteTitle ? { absolute: title } : title,
    description,
    robots: { index: false, follow: false },
    ...(options.referrer ? { referrer: options.referrer } : {}),
    openGraph: {
      type: "website",
      locale: "he_IL",
      title,
      description,
      ...(business ? { siteName: business } : {}),
      // an explicit empty list: no image, rather than the app's own share image
      images,
    },
    twitter: { card: "summary", title, description, images },
  };
}

/** The preview of a page whose business is not known (not found, closed, too many views): what the page is, no more. */
export function genericPreview(what: string, description: string): Metadata {
  return linkPreviewMetadata({ title: what, description, business: null, logoUrl: null });
}

/** A business's page: "<what> <joiner> <business>", e.g. "הצעת מחיר מאת <עסק>". */
export function businessPreview(
  input: { what: string; joiner: string; business: string; logoUrl: string | null; description: string; siteName?: string },
  options: Omit<PageOptions, "absoluteTitle"> = {},
): Metadata {
  const business = input.business.trim();
  const title = business ? `${input.what} ${input.joiner} ${business}` : input.what;
  const siteName = (input.siteName ?? business).trim();
  return linkPreviewMetadata(
    { title, description: input.description, business: siteName || null, logoUrl: input.logoUrl },
    { ...options, absoluteTitle: business !== "" },
  );
}

// The texts of each page (Hebrew, short; none names the customer or says anything about their deal) -----------------

export const PREVIEW_TEXTS = {
  form: { what: "טופס פנייה", joiner: "של", description: "משאירים פרטים בקישור, והעסק חוזר אליכם. בלי הרשמה ובלי אפליקציה." },
  quote: { what: "הצעת מחיר", joiner: "מאת", description: "צפייה בהצעת המחיר בקישור, בלי הרשמה ובלי אפליקציה." },
  order: { what: "אישור הזמנה", joiner: "מאת", description: "צפייה בפרטי ההזמנה בקישור, בלי הרשמה ובלי אפליקציה." },
  booking: { what: "קביעת תור", joiner: "אצל", description: "בוחרים זמן פנוי וקובעים בקישור, בלי הרשמה ובלי אפליקציה." },
  manage: { what: "הפגישה שלך", joiner: "אצל", description: "פרטי הפגישה שנקבעה, בקישור אישי." },
  card: { what: "כרטיס ביקור", joiner: "של", description: "כרטיס ביקור דיגיטלי: חיוג, WhatsApp ושמירה באנשי הקשר." },
} as const;
