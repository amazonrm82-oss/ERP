import type { Metadata } from "next";

import { logoPublicUrl } from "@/features/branding/logo";
import { businessPreview, genericPreview, PREVIEW_TEXTS } from "@/lib/link-preview";

// WAB-05 follow-up: what a listed preview bot gets for a customer page (src/lib/preview-bots.ts). Pure: the shape of
// public.link_preview_public's answer, the metadata built from it, and the one line of the page's minimal body.

export type PreviewKind = "form" | "quote" | "order" | "booking" | "booking_manage" | "card";

export type BotPreview = {
  /** the business's DISPLAY name (organizations.name; owner, 27 October 2026, answer (2) ב), never the registered name */
  business: string;
  logoPath: string | null;
  /** a card only: the name the card itself always shows (the rep's, else the business's) */
  rep: string | null;
};

export type BotPreviewState = BotPreview | "not-found" | "rate-limited" | "not-configured";

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/** public.link_preview_public's answer: {kind, business, logo[, rep]} | {not_found} | {refused: 'rate'}. */
export function botPreviewFrom(data: unknown): BotPreviewState {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "not-found";
  const row = data as Record<string, unknown>;
  if (row.refused === "rate") return "rate-limited";
  const business = text(row.business);
  if (row.not_found === true || business === null) return "not-found";
  return { business, logoPath: text(row.logo), rep: text(row.rep) };
}

const TEXTS: Record<PreviewKind, { what: string; joiner: string; description: string }> = {
  form: PREVIEW_TEXTS.form,
  quote: PREVIEW_TEXTS.quote,
  order: PREVIEW_TEXTS.order,
  booking: PREVIEW_TEXTS.booking,
  booking_manage: PREVIEW_TEXTS.manage,
  card: PREVIEW_TEXTS.card,
};

/** QUO-14: the quote and order pages never send their secret address in a Referer header. */
const NO_REFERRER: ReadonlySet<PreviewKind> = new Set(["quote", "order"]);

/** The preview a listed bot draws: "<what> <joiner> <business>" and the logo, or the page's generic preview. */
export function botPreviewMetadata(kind: PreviewKind, state: BotPreviewState): Metadata {
  const t = TEXTS[kind];
  const options = NO_REFERRER.has(kind) ? { referrer: "no-referrer" as const } : {};
  if (typeof state === "string") return { ...genericPreview(t.what, t.description), ...options };
  // a card: the name it always shows, then the business (as the human page's preview)
  const who = kind === "card" && state.rep && state.rep !== state.business ? `${state.rep} · ${state.business}` : state.business;
  return businessPreview(
    { what: t.what, joiner: t.joiner, business: who, siteName: state.business, logoUrl: logoPublicUrl(state.logoPath), description: t.description },
    options,
  );
}

/** The one line a bot's page shows: what the link is, and whose. */
export function botPreviewLine(kind: PreviewKind, state: BotPreviewState): string {
  const t = TEXTS[kind];
  return typeof state === "string" ? t.what : `${t.what} ${t.joiner} ${state.business}`;
}
