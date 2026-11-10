import { normalizePhone } from "@/lib/phone";

import type { LeadSourceOption, LeadStatusOption } from "./queries";

// UX-03: the new-lead form starts with the source and status this user picked last time in this business,
// kept on this device only (localStorage). Pure helpers here; the form reads and writes the storage inside
// try/catch, so a private window or blocked storage simply starts with the defaults.

export type LeadFormMemory = { sourceId: string | null; statusId: string | null };

const PREFIX = "mx-lead-form";

/** One key per user and business. */
export function leadFormMemoryKey(userId: string, orgId: string): string {
  return `${PREFIX}:${orgId}:${userId}`;
}

/** What is stored: ids only. An empty source ("ללא מקור") is remembered as null. */
export function serializeLeadFormMemory(memory: LeadFormMemory): string {
  return JSON.stringify({ v: 1, source: memory.sourceId || null, status: memory.statusId || null });
}

/**
 * The remembered choice, kept only while it still fits the form: an active source of the business, and a
 * status a new lead may start in that does not ask anything more (not converted, not "not relevant", which
 * needs a reason). Anything else, or a stored value that does not parse, is dropped.
 */
export function readLeadFormMemory(raw: string | null, sources: LeadSourceOption[], statuses: LeadStatusOption[]): LeadFormMemory {
  const none: LeadFormMemory = { sourceId: null, statusId: null };
  if (!raw) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return none;
  }
  if (!parsed || typeof parsed !== "object") return none;
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) return none;
  const source = typeof record.source === "string" ? record.source : null;
  const status = typeof record.status === "string" ? record.status : null;
  return {
    sourceId: source && sources.some((s) => s.id === source && s.isActive) ? source : null,
    statusId: status && statuses.some((s) => s.id === status && s.kind !== "converted" && s.kind !== "disqualified") ? status : null,
  };
}

// characters people paste around a number: spaces (also no-break and thin), dashes of every kind, brackets,
// dots and the invisible direction marks that copying from an RTL page adds
const PHONE_DECORATION = /[\s   ‐-―−().‎‏‪-‮⁦-⁩-]/g;

/**
 * UX-03: a pasted phone number, cleaned: decoration removed, and an Israeli number in international form
 * (+972 / 00972 / 972…) written the local way with a leading 0, by the same rules as normalizePhone().
 * A foreign number keeps its "+" and digits. Returns null when the pasted text is not just a phone number
 * (letters, several numbers, nothing left), so the browser pastes it unchanged.
 */
export function cleanPastedPhone(text: string): string | null {
  const bare = text.replace(PHONE_DECORATION, "");
  // at most 15 digits (E.164), 17 with a leading 00: two numbers pasted together are left alone
  if (!/^(\+\d{3,15}|00\d{3,15}|\d{3,15})$/.test(bare)) return null;
  const e164 = normalizePhone(bare);
  if (!e164) return null;
  if (e164.startsWith("+972")) {
    // "+972 (0)50 …" carries the local 0 as well
    const national = e164.slice(4).replace(/^0(?=\d{8,9}$)/, "");
    // only a whole Israeli number (8 or 9 digits after the country code); anything else stays as typed
    if (/^\d{8,9}$/.test(national)) return `0${national}`;
    return bare;
  }
  return bare.startsWith("+") || bare.startsWith("00") ? e164 : bare;
}

/**
 * UX-03: what the while-typing duplicate check asks about, or null while there is nothing worth asking yet:
 * a phone with 9 to 15 digits, an email that looks whole (something@domain.tld). The save itself still runs
 * the same check (DQL-02), so a warning missed here is never a duplicate saved without a word.
 */
export function duplicateLookupInput(phone: string, email: string): { phone: string | null; email: string | null } | null {
  const digits = phone.replace(/\D/g, "");
  const usePhone = digits.length >= 9 && digits.length <= 15 ? phone.trim() : null;
  const trimmed = email.trim();
  const useEmail = trimmed.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed) ? trimmed : null;
  return usePhone || useEmail ? { phone: usePhone, email: useEmail } : null;
}
