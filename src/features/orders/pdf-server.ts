import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadPdfLogo } from "@/features/pdf/logo";
import { renderPdf } from "@/features/pdf/render";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";

import { getOrderDocumentData } from "./document-server";
import { orderPdfDocument, orderPdfFileName, orderPdfOutdated } from "./pdf";
import { writeOrderPdfAsServer } from "./pdf-store-server";
import { readOrder, type Order } from "./queries";

export { orderPdfOutdated };

type Client = SupabaseClient<Database>;

// fileId null: nothing to keep (an edit of an order that has no PDF yet makes none)
export type OrderPdfResult = { ok: true; fileId: string | null } | { ok: false; message: string };

const NOT_MADE = "קובץ ה-PDF לא נשמר. נסו שוב בעוד רגע.";
const IN_PROGRESS = "קובץ ה-PDF של ההזמנה בהכנה. נסו שוב בעוד כמה דקות.";
const NOT_PERMITTED = "אין לכם הרשאה לשמור את קובץ ה-PDF של ההזמנה הזאת.";
const CLOSED = "קובץ PDF נשמר רק להזמנה ממוספרת שלא בוטלה.";

/** A PDF is made only for a numbered order that is not cancelled (the database decides again). */
export function orderPdfStorable(order: Pick<Order, "status" | "customerDeletedAt">): boolean {
  return order.status !== "draft" && order.status !== "cancelled" && order.customerDeletedAt === null;
}

// contentStamp: the orders.pdf_content_changed_at its render read (review, medium: the file is judged by it, never by createdAt)
export type OrderPdfFile = { id: string; name: string; createdAt: string; contentStamp: string | null };

/**
 * The stored PDFs of an order (confirmed files), newest first, read with the user's session: whoever reads the order. The first
 * is the one the customer's link serves; the rest are its earlier versions (owner's answer (34) ב: kept for staff).
 */
export async function listOrderPdfFiles(supabase: Client, orgId: string, orderId: string): Promise<OrderPdfFile[]> {
  const { data, error } = await supabase
    .from("files")
    .select("id, name, created_at, unconfirmed_since, order_content_stamp")
    .eq("organization_id", orgId)
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(100);
  if (error) throw new Error(`order pdf: ${error.message}`);
  return (data ?? []).filter((row) => row.unconfirmed_since === null).map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, contentStamp: row.order_content_stamp }));
}

/** The current stored PDF of an order (the newest confirmed version), or null. */
export async function getOrderPdfFile(supabase: Client, orgId: string, orderId: string): Promise<OrderPdfFile | null> {
  return (await listOrderPdfFiles(supabase, orgId, orderId))[0] ?? null;
}


/**
 * ORD-05 PDF (owner, 1 November 2026, answer (1) ב): makes the PDF of a numbered order and keeps it, once, counted against
 * max_pdf_per_month (a stored file is never made again; since the owner's answer (34) ב a change to the delivery date, the
 * shipping address or the notes makes a new version, counted the same way, and the earlier one is kept for staff). The person's right is asked here with their own session
 * (public.order_pdf_allowed), the PDF is rendered here from the order document, and the row and the object are written with
 * the service key through public.order_pdf_store alone (pdf-store-server.ts), which checks the user again and keeps the
 * file's SHA-256.
 */
export async function storeOrderPdf(
  supabase: Client,
  orgId: string,
  order: Order,
  userId: string,
  options: { onlyNewVersion?: boolean } = {},
): Promise<OrderPdfResult> {
  if (order.status === "draft") return { ok: false, message: "לטיוטה אין קובץ PDF. הקובץ נשמר כשההזמנה מקבלת מספר." };
  let current = order;
  // review (medium): the render names the content it read; when another editor changed the order meanwhile, the database
  // answers "changed" and the order is read and rendered again, once
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await getOrderPdfFile(supabase, orgId, current.id).catch(() => null);
    // stored once; a new version only after the delivery date, shipping address or notes changed (answer (34) ב)
    if (existing && !orderPdfOutdated(current, existing)) return { ok: true, fileId: existing.id };
    // after an edit: only a new version of a PDF that exists (the first one is made when the order is numbered, or by hand)
    if (options.onlyNewVersion && !existing) return { ok: true, fileId: null };
    if (!orderPdfStorable(current)) return { ok: false, message: CLOSED };

    // the person's own session decides first (writable business, the flag, may edit the order's deal, contact or company)
    const allowed = await supabase.rpc("order_pdf_allowed", { p_org: orgId, p_order: current.id });
    if (allowed.error) return { ok: false, message: dbErrorMessage(allowed.error) };
    if (allowed.data !== true) return { ok: false, message: NOT_PERMITTED };

    const org = await supabase.from("organizations").select("name").eq("id", orgId).maybeSingle();
    if (org.error || !org.data) return { ok: false, message: NOT_MADE };
    const data = await getOrderDocumentData(orgId, current, org.data.name);
    const bytes = await renderPdf(orderPdfDocument(data, await loadPdfLogo(data.logoUrl)));

    const stored = await writeOrderPdfAsServer({
      orgId,
      orderId: current.id,
      userId,
      bytes,
      name: orderPdfFileName(current.numberDisplay),
      contentStamp: current.pdfContentChangedAt ?? null,
    });
    if (stored.ok) return { ok: true, fileId: stored.fileId };
    if (!stored.changed) return { ok: false, message: stored.busy ? IN_PROGRESS : stored.message };
    const reread = await readOrder(supabase, orgId, current.id).catch(() => null);
    if (!reread) return { ok: false, message: NOT_MADE };
    current = reread;
  }
  return { ok: false, message: NOT_MADE };
}
