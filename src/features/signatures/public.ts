import { z } from "zod";

import { SIGNATURE_IMAGE, SIGNATURE_IMAGE_MAX } from "@/features/quotes/decision";
import { RATE_LIMITED_TEXT } from "@/lib/public-rate-limit";

// SGN-02 (owner, 9 November 2026, answer (191) א): the customer's page of a document sent for signature, and what it posts.

export const SIGNATURE_LINK_TOKEN = /^[A-Za-z0-9_-]{64}$/;

/** The customer's page of a document (the link sent from the record). */
export const publicSignaturePath = (token: string) => `/f/sign/${token}`;

/** The route the page posts the signature to. */
export const publicSignatureSignPath = (token: string) => `/api/forms/sign/${encodeURIComponent(token)}`;
/** (223) ב: the customer's download of the signed PDF, after signing */
export const publicSignaturePdfPath = (token: string) => `/api/forms/sign/${encodeURIComponent(token)}/pdf`;

/**
 * The checkbox wording a signature agrees to. DRAFT: legal wording drafted by Claude Code, to be edited by the lawyer (owner's
 * decision of 8 October 2026; answer (191)). Any change to the text gets a new version string, which is stored with every
 * signature (public.signature_signatures.wording_version).
 */
export const SIGN_WORDING = "קראתי את המסמך ואני מאשר/ת את תוכנו. החתימה שלי כאן מחייבת כמו חתימה בכתב יד.";
export const SIGN_WORDING_VERSION = "sign-draft-2026-11-10";

const text = (max: number) => z.string().min(1).max(max);
const at = z.string().refine((value) => !Number.isNaN(Date.parse(value)));

const pageSchema = z.object({
  document: z.object({
    title: text(120),
    body: text(30000),
    status: z.enum(["sent", "viewed", "signed"]),
    sent_at: at,
    signed_at: at.nullable(),
    expires_at: at.nullable(),
  }),
  business: z.object({ name: text(200), phone: z.string().max(40).nullable() }),
  brand: z.object({ logo: z.string().max(300).nullable(), color: z.string().max(20).nullable() }),
  built_with: z.boolean(),
  time_zone: z.string().min(1).max(64).optional(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});

const statusSchema = z.object({
  status_page: z.object({
    state: z.enum(["cancelled", "expired"]),
    title: text(120),
    business: text(200),
    logo: z.string().max(300).nullable(),
    color: z.string().max(20).nullable(),
    phone: z.string().max(40).nullable(),
  }),
});

export type PublicSignatureDocument = {
  title: string;
  body: string;
  status: "sent" | "viewed" | "signed";
  sentAt: string;
  signedAt: string | null;
  expiresAt: string | null;
  business: string;
  phone: string | null;
  logoPath: string | null;
  color: string | null;
  builtWith: boolean;
  // the business's time zone, for the page's dates
  timeZone: string;
  // what a signature must name; null once signed
  fingerprint: string | null;
};

export type StatusSignatureDocument = {
  statusPage: true;
  state: "cancelled" | "expired";
  title: string;
  business: string;
  phone: string | null;
  logoPath: string | null;
  color: string | null;
};

/** public.signature_public's full answer, or null for another shape. */
export function publicSignatureFrom(raw: unknown): PublicSignatureDocument | null {
  const parsed = pageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  return {
    title: p.document.title,
    body: p.document.body,
    status: p.document.status,
    sentAt: p.document.sent_at,
    signedAt: p.document.signed_at,
    expiresAt: p.document.expires_at,
    business: p.business.name,
    phone: p.business.phone,
    logoPath: p.brand.logo,
    color: p.brand.color,
    builtWith: p.built_with,
    timeZone: p.time_zone ?? "Asia/Jerusalem",
    fingerprint: p.fingerprint,
  };
}

/** public.signature_public's state-only answer (cancelled, expired), or null for another shape. */
export function statusSignatureFrom(raw: unknown): StatusSignatureDocument | null {
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data.status_page;
  return { statusPage: true, state: s.state, title: s.title, business: s.business, phone: s.phone, logoPath: s.logo, color: s.color };
}

/** What the page posts; the database checks every field again. */
export const signBodySchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  signerName: z.string().trim().min(2).max(120),
  idNumber: z.string().trim().max(12).nullable(),
  signatureKind: z.enum(["drawn", "typed"]),
  signatureImage: z.string().max(SIGNATURE_IMAGE_MAX).regex(SIGNATURE_IMAGE).nullable(),
  agreed: z.literal(true),
});
export type SignBody = z.infer<typeof signBodySchema>;

export type SignStatus = "signed" | "already_signed" | "closed" | "changed" | "invalid" | "rate_limited";

/** The Hebrew answer the page shows for each outcome. */
export const SIGN_MESSAGES: Record<SignStatus, string> = {
  signed: "תודה! המסמך נחתם.",
  already_signed: "המסמך הזה כבר נחתם.",
  closed: "המסמך כבר לא מחכה לחתימה. רעננו את הדף.",
  changed: "המסמך התעדכן בזמן שהדף היה פתוח. רעננו את הדף ונסו שוב.",
  invalid: "חלק מהפרטים לא תקינים. בדקו את השם, תעודת הזהות והחתימה.",
  rate_limited: RATE_LIMITED_TEXT,
};

export function isSignStatus(value: unknown): value is SignStatus {
  return typeof value === "string" && Object.hasOwn(SIGN_MESSAGES, value);
}

/** A date as the customer's page writes it, in the business's time zone (Israel when the zone is unknown). */
export function signatureDateText(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeZone: "Asia/Jerusalem" }).format(date);
  }
}
