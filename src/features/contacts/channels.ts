// CON-01: a contact's phones and emails. The primary one of each stays on the contact row
// (contacts.phone / email, with phone_type / email_type); further ones are rows of
// public.contact_channels. Pure code, shared by the form (browser) and the actions (server).

import { z } from "zod";

import { normalizePhone } from "@/lib/phone";
import { optionalEmail, optionalPhone } from "@/lib/validation";

export type ChannelKind = "phone" | "email";

export const PHONE_TYPES = ["mobile", "work", "home", "other"] as const;
export const EMAIL_TYPES = ["work", "home", "other"] as const;

const LABELS: Record<ChannelKind, Record<string, string>> = {
  phone: { mobile: "נייד", work: "עבודה", home: "בית", other: "אחר" },
  email: { work: "עבודה", home: "אישי", other: "אחר" },
};

/** The types a kind offers, in the order the form shows them. */
export function channelTypes(kind: ChannelKind): ReadonlyArray<string> {
  return kind === "phone" ? PHONE_TYPES : EMAIL_TYPES;
}

/** The Hebrew name of a type, or null for none / an unknown one. */
export function channelTypeLabel(kind: ChannelKind, type: string | null | undefined): string | null {
  return (type && LABELS[kind][type]) || null;
}

/** At most this many further phones (and, apart, emails) per contact; mirrors the database trigger. */
export const MAX_EXTRA_CHANNELS = 10;

/** One row of the form: id of a stored further one (null for new or for the stored primary). */
export type ChannelDraft = { id: string | null; type: string; value: string; primary: boolean };

/** A stored further phone or email, as read for the card and the form. */
export type StoredChannel = { id: string; kind: ChannelKind; label: string; value: string; value_e164: string | null; position: number };

/** The form's starting rows: the primary first, then the further ones in their order. */
export function draftsFrom(kind: ChannelKind, primary: string | null | undefined, primaryType: string | null | undefined, extras: StoredChannel[]): ChannelDraft[] {
  const rows: ChannelDraft[] = [];
  const key = (v: string) => matchKey(kind, v);
  if (primary && primary.trim()) {
    rows.push({ id: null, type: primaryType && channelTypes(kind).includes(primaryType) ? primaryType : defaultType(kind), value: primary, primary: true });
  }
  for (const ch of [...extras].filter((c) => c.kind === kind).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))) {
    // a stored one that equals the primary (written by another path) is dropped: saving removes it
    if (rows.some((r) => key(r.value) === key(ch.value))) continue;
    rows.push({ id: ch.id, type: ch.label, value: ch.value, primary: false });
  }
  return rows;
}

export function defaultType(kind: ChannelKind): string {
  return kind === "phone" ? "mobile" : "other";
}

/** What makes two values the same: the normalized number, or the lower-cased address. */
export function matchKey(kind: ChannelKind, value: string): string {
  const trimmed = value.trim();
  return kind === "phone" ? (normalizePhone(trimmed) ?? trimmed) : trimmed.toLowerCase();
}

const draftSchema = z.array(
  z.object({
    id: z.union([z.guid(), z.null()]),
    type: z.string().max(20),
    value: z.string().max(300),
    primary: z.boolean(),
  }),
);

export type ParsedChannels = {
  primary: { value: string; type: string } | null;
  // in the order shown, without the primary
  extras: Array<{ id: string | null; type: string; value: string }>;
};

const NOUN: Record<ChannelKind, string> = { phone: "טלפון", email: "אימייל" };

/**
 * Reads the JSON the form sends for one kind. Empty rows are dropped; the row marked
 * primary (else the first) becomes the primary. Every value is checked like the single
 * field was, and a value may appear only once.
 */
export function parseChannels(kind: ChannelKind, raw: FormDataEntryValue | null): { ok: true; value: ParsedChannels } | { ok: false; message: string } {
  // a form without the field (an old page) must not clear anything: only an explicit list counts
  if (typeof raw !== "string") {
    return { ok: false, message: "הטופס אינו מעודכן. רעננו את הדף ונסו שוב." };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, message: "הפרטים שנשלחו אינם תקינים. רעננו את הדף ונסו שוב." };
  }
  const parsed = draftSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, message: "הפרטים שנשלחו אינם תקינים. רעננו את הדף ונסו שוב." };
  }
  const rows = parsed.data.map((r) => ({ ...r, value: r.value.trim() })).filter((r) => r.value !== "");
  // a sanity bound; the real limit (no new rows past 10 further ones) is checked below
  if (rows.length > 100) {
    return { ok: false, message: "הפרטים שנשלחו אינם תקינים. רעננו את הדף ונסו שוב." };
  }
  const types = channelTypes(kind);
  const field = kind === "phone" ? optionalPhone : optionalEmail;
  const seen = new Set<string>();
  const clean: Array<{ id: string | null; type: string; value: string; primary: boolean }> = [];
  for (const [i, row] of rows.entries()) {
    const where = rows.length > 1 ? `${NOUN[kind]} ${i + 1}: ` : "";
    const checked = field.safeParse(row.value);
    if (!checked.success || checked.data === null) {
      return { ok: false, message: where + (kind === "phone" ? "מספר הטלפון אינו תקין." : "כתובת האימייל אינה תקינה.") };
    }
    if (!types.includes(row.type)) {
      return { ok: false, message: `${where}יש לבחור סוג מהרשימה.` };
    }
    const key = matchKey(kind, checked.data);
    if (seen.has(key)) {
      return { ok: false, message: `${where}${kind === "phone" ? "המספר כבר מופיע ברשימה." : "הכתובת כבר מופיעה ברשימה."}` };
    }
    seen.add(key);
    clean.push({ id: row.id, type: row.type, value: checked.data, primary: row.primary });
  }
  if (clean.length === 0) {
    return { ok: true, value: { primary: null, extras: [] } };
  }
  const primaryAt = Math.max(0, clean.findIndex((r) => r.primary));
  const primary = clean[primaryAt];
  const extras = clean.filter((_, i) => i !== primaryAt).map(({ id, type, value }) => ({ id, type, value }));
  // more than 10 further ones is refused only when one of them is new: a contact that has more
  // (a merge may leave them) keeps them and can still be saved
  if (extras.length > MAX_EXTRA_CHANNELS && extras.some((e) => e.id === null)) {
    return { ok: false, message: `אפשר לשמור עד ${MAX_EXTRA_CHANNELS} ${kind === "phone" ? "טלפונים נוספים" : "אימיילים נוספים"} מלבד הראשי.` };
  }
  return { ok: true, value: { primary: { value: primary.value, type: primary.type }, extras } };
}

export type ChannelPlan = {
  remove: string[];
  update: Array<{ id: string; label: string; position: number }>;
  insert: Array<{ kind: ChannelKind; label: string; value: string; position: number }>;
};

/**
 * What to change so the stored further ones become the wanted list. A row whose value
 * changed is removed and added again (so a swap of values never meets the "once per
 * contact" index half way); a stored row that is not on the list any more is removed.
 */
export function planChannels(kind: ChannelKind, stored: StoredChannel[], wanted: ParsedChannels["extras"]): ChannelPlan {
  const mine = stored.filter((c) => c.kind === kind);
  const byId = new Map(mine.map((c) => [c.id, c]));
  const kept = new Set<string>();
  const plan: ChannelPlan = { remove: [], update: [], insert: [] };
  wanted.forEach((w, position) => {
    const old = w.id ? byId.get(w.id) : undefined;
    if (old && !kept.has(old.id) && matchKey(kind, old.value) === matchKey(kind, w.value) && old.value === w.value) {
      kept.add(old.id);
      if (old.label !== w.type || old.position !== position) plan.update.push({ id: old.id, label: w.type, position });
    } else {
      plan.insert.push({ kind, label: w.type, value: w.value, position });
    }
  });
  plan.remove = mine.filter((c) => !kept.has(c.id)).map((c) => c.id);
  return plan;
}
