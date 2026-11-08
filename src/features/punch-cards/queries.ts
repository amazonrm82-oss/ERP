import "server-only";

import { cache } from "react";

import { getMyPermissions } from "@/features/permissions/queries";
import { canRecordPayments } from "@/features/permissions/keys";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/features/payments/schema";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { formatDate, formatMoney, zoneDate } from "@/lib/format";
import { readAllPagesByIds } from "@/lib/paged-read";
import { createClient } from "@/lib/supabase/server";

import { expiryNear, PUNCH_ALERT_DEFAULTS, type PunchAlertSettings } from "./alerts";
import { punchBalance, refundSuggestion, type PunchBalance } from "./balance";

// PKG-01, PKG-02: a contact's punch cards and their entries, read with the user's session (RLS: whoever reads the contact).

export type PunchAccess = {
  inPlan: boolean;
  // open a card, link a payment to a waiting one: whoever records payments (app.punch_card_seller)
  canSell: boolean;
  // activate by hand, cancel, transfer: owners and admins
  isAdmin: boolean;
  // give a used entry back: owners, admins and managers (by role)
  canReturn: boolean;
};

export const getPunchAccess = cache(async (orgId: string): Promise<PunchAccess> => {
  const [inPlan, context, granted] = await Promise.all([orgHasFeature(orgId, "punch_cards"), getOrgContext(orgId), getMyPermissions(orgId)]);
  const writable = context.canWrite;
  const isAdmin = context.role === "owner" || context.role === "admin";
  return {
    inPlan,
    canSell: inPlan && writable && canRecordPayments(context.role, granted),
    isAdmin: writable && isAdmin,
    canReturn: writable && (isAdmin || context.role === "manager"),
  };
});

/** PKG-03: the business's alert numbers (no row = the defaults), read by every member. */
export const getPunchAlertSettings = cache(async (orgId: string): Promise<PunchAlertSettings> => {
  const supabase = await createClient();
  const row = must(
    await supabase.from("punch_card_alert_settings").select("low_entries, expiry_days, customer_messages").eq("organization_id", orgId).maybeSingle(),
    "punch card alert settings",
  );
  return {
    lowEntries: row?.low_entries ?? PUNCH_ALERT_DEFAULTS.lowEntries,
    expiryDays: row?.expiry_days ?? PUNCH_ALERT_DEFAULTS.expiryDays,
    customerMessages: row?.customer_messages ?? PUNCH_ALERT_DEFAULTS.customerMessages,
  };
});

export type PunchCardUseItem = {
  id: string;
  usedOn: string;
  meetingTitle: string | null;
  returned: boolean;
  returnText: string | null;
};

export type PunchCardItem = {
  id: string;
  name: string;
  status: string;
  // PKG-03: the product it was sold from ("חידוש" opens the same product)
  productId: string;
  balance: PunchBalance;
  expiresOn: string | null;
  // PKG-03: a usable card whose last day is within the business's number of days
  expiryNear: boolean;
  activatedText: string | null;
  cancelReason: string | null;
  // review finding 1: the payment that opened it no longer counts (failed, cancelled, refunded in full)
  paymentVoid: boolean;
  // owner (84) ב: the payment a refund goes on, its method, and the unused part's suggested refund
  refund: { paymentId: string; method: PaymentMethod; suggestedAgorot: number } | null;
  uses: PunchCardUseItem[];
};

/** A contact's cards (newest first) with their balance by the business's today. */
export async function listContactPunchCards(orgId: string, contactId: string, timeZone: string): Promise<PunchCardItem[]> {
  const supabase = await createClient();
  const cards = must(
    await supabase
      .from("punch_cards")
      .select("id, name, status, product_id, entries_total, expires_on, activated_at, activated_by, activated_manually, payment_id, cancel_reason, price_agorot, payment_void_at")
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .order("id"),
    "punch cards",
  );
  if (cards.length === 0) return [];
  const uses = await readAllPagesByIds(
    cards.map((c) => c.id),
    async (ids, from, to) =>
      must(
        await supabase
        .from("punch_card_uses")
        .select("id, card_id, meeting_id, used_on, returned_at, return_kind, return_reason, returned_by")
        .eq("organization_id", orgId)
        .in("card_id", ids)
        .order("used_on", { ascending: false })
        .order("id")
        .range(from, to),
        "punch card uses",
      ),
  );
  const meetingIds = [...new Set(uses.map((u) => u.meeting_id).filter((id): id is string => Boolean(id)))];
  const meetings = meetingIds.length
    ? must(await supabase.from("meetings").select("id, title").eq("organization_id", orgId).in("id", meetingIds), "punch card meetings")
    : [];
  const titles = new Map(meetings.map((m) => [m.id, m.title]));
  const names = await getUserNames([...cards.map((c) => c.activated_by), ...uses.map((u) => u.returned_by)]);
  const paymentIds = [...new Set(cards.map((c) => c.payment_id).filter((id): id is string => Boolean(id)))];
  const payments = paymentIds.length
    ? must(await supabase.from("payments").select("id, method").eq("organization_id", orgId).in("id", paymentIds), "punch card payments")
    : [];
  const methods = new Map(payments.map((p) => [p.id, p.method as PaymentMethod]));
  const today = zoneDate(new Date(), timeZone);
  const alerts = await getPunchAlertSettings(orgId);
  return cards.map((card) => {
    const own = uses.filter((u) => u.card_id === card.id);
    const live = own.filter((u) => u.returned_at === null).length;
    const by = card.activated_by ? names.get(card.activated_by) : undefined;
    const balance = punchBalance({ status: card.status, entriesTotal: card.entries_total, expiresOn: card.expires_on }, live, today, alerts.lowEntries);
    const method = card.payment_id ? methods.get(card.payment_id) : undefined;
    return {
      id: card.id,
      name: card.name,
      status: card.status,
      productId: card.product_id,
      balance,
      expiresOn: card.expires_on,
      expiryNear: expiryNear({ usable: balance.usable, expiresOn: card.expires_on }, today, alerts.expiryDays),
      activatedText: card.activated_at
        ? `הופעלה ב-${formatDate(card.activated_at)}${card.activated_manually ? " ידנית" : card.payment_id ? " עם תשלום" : ""}${by ? ` על ידי ${by}` : ""}`
        : null,
      cancelReason: card.cancel_reason,
      paymentVoid: card.payment_void_at !== null,
      refund:
        card.payment_id && method && card.payment_void_at === null
          ? { paymentId: card.payment_id, method, suggestedAgorot: refundSuggestion(balance.remaining, balance.total, card.price_agorot) }
          : null,
      uses: own.map((u) => ({
        id: u.id,
        usedOn: u.used_on,
        meetingTitle: u.meeting_id ? (titles.get(u.meeting_id) ?? null) : null,
        returned: u.returned_at !== null,
        returnText:
          u.returned_at === null
            ? null
            : u.return_kind === "manual"
              ? `הוחזרה${u.returned_by && names.get(u.returned_by) ? ` על ידי ${names.get(u.returned_by)}` : ""}: ${u.return_reason ?? ""}`
              : "הוחזרה: הפגישה כבר לא מסומנת \"התקיימה\"",
      })),
    };
  });
}

export type PunchProductChoice = { id: string; label: string };

/** The punch card products a card can be opened from: active, not archived, with entries set. */
export async function listPunchProducts(orgId: string): Promise<PunchProductChoice[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("products")
      .select("id, name, punch_entries")
      .eq("organization_id", orgId)
      .eq("kind", "punch_card")
      .eq("is_active", true)
      .is("archived_at", null)
      .not("punch_entries", "is", null)
      .order("name")
      .limit(200),
    "punch card products",
  );
  return rows.map((r) => ({ id: r.id, label: `${r.name} (${r.punch_entries} כניסות)` }));
}

export type PaymentChoice = { id: string; label: string };

/** The contact's counted payments (recorded or confirmed), newest first: a card opens with one of them. */
export async function listContactPayments(orgId: string, contactId: string): Promise<PaymentChoice[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("payments")
      .select("id, paid_on, amount_agorot, method")
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .in("status", ["recorded", "confirmed"])
      .order("paid_on", { ascending: false })
      .order("id")
      .limit(50),
    "contact payments",
  );
  return rows.map((r) => ({
    id: r.id,
    label: `${formatDate(r.paid_on)} · ${formatMoney(r.amount_agorot)} · ${PAYMENT_METHOD_LABELS[r.method as keyof typeof PAYMENT_METHOD_LABELS] ?? r.method}`,
  }));
}

/** PKG-02: "יתרת כרטיסייה" lines for booking a meeting with the contact: its usable cards only. */
export async function usablePunchBalances(orgId: string, contactId: string, timeZone: string): Promise<string[]> {
  const cards = await listContactPunchCards(orgId, contactId, timeZone);
  return cards
    .filter((card) => card.balance.usable)
    .map((card) => `${card.name}: ${card.balance.remaining === 1 ? "נשארה כניסה אחת" : `נשארו ${card.balance.remaining} כניסות`}${card.expiresOn ? `, בתוקף עד ${formatDate(card.expiresOn)}` : ""}`);
}

export type PunchSettings = {
  entries: number | null;
  validityCount: number | null;
  validityUnit: string | null;
  meetingTypeIds: string[];
};

/** PKG-01: a punch card product's settings. */
export async function getPunchSettings(orgId: string, productId: string): Promise<PunchSettings | null> {
  const supabase = await createClient();
  const row = must(
    await supabase
      .from("products")
      .select("punch_entries, punch_validity_count, punch_validity_unit, punch_meeting_type_ids")
      .eq("organization_id", orgId)
      .eq("id", productId)
      .eq("kind", "punch_card")
      .maybeSingle(),
    "punch card settings",
  );
  if (!row) return null;
  return {
    entries: row.punch_entries,
    validityCount: row.punch_validity_count,
    validityUnit: row.punch_validity_unit,
    meetingTypeIds: row.punch_meeting_type_ids ?? [],
  };
}
