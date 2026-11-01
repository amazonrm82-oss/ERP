import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadPdfLogo } from "@/features/pdf/logo";
import { renderPdf } from "@/features/pdf/render";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";

import { getOrderDocumentData } from "./document-server";
import { orderPdfDocument, orderPdfFileName } from "./pdf";
import { writeOrderPdfAsServer } from "./pdf-store-server";
import type { Order } from "./queries";

type Client = SupabaseClient<Database>;

export type OrderPdfResult = { ok: true; fileId: string } | { ok: false; message: string };

const NOT_MADE = "קובץ ה-PDF לא נשמר. נסו שוב בעוד רגע.";
const IN_PROGRESS = "קובץ ה-PDF של ההזמנה בהכנה. נסו שוב בעוד כמה דקות.";
const NOT_PERMITTED = "אין לכם הרשאה לשמור את קובץ ה-PDF של ההזמנה הזאת.";
const CLOSED = "קובץ PDF נשמר רק להזמנה ממוספרת שלא בוטלה.";

/** A PDF is made only for a numbered order that is not cancelled (the database decides again). */
export function orderPdfStorable(order: Pick<Order, "status" | "customerDeletedAt">): boolean {
  return order.status !== "draft" && order.status !== "cancelled" && order.customerDeletedAt === null;
}

/** The stored PDF of an order (a confirmed file), or null. Read with the user's session: whoever reads the order. */
export async function getOrderPdfFile(supabase: Client, orgId: string, orderId: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await supabase
    .from("files")
    .select("id, name, unconfirmed_since")
    .eq("organization_id", orgId)
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw new Error(`order pdf: ${error.message}`);
  return data && data.unconfirmed_since === null ? { id: data.id, name: data.name } : null;
}

/**
 * ORD-05 PDF (owner, 1 November 2026, answer (1) ב): makes the PDF of a numbered order and keeps it, once, counted against
 * max_pdf_per_month (a stored file is never made again). The person's right is asked here with their own session
 * (public.order_pdf_allowed), the PDF is rendered here from the order document, and the row and the object are written with
 * the service key through public.order_pdf_store alone (pdf-store-server.ts), which checks the user again and keeps the
 * file's SHA-256.
 */
export async function storeOrderPdf(supabase: Client, orgId: string, order: Order, userId: string): Promise<OrderPdfResult> {
  if (order.status === "draft") return { ok: false, message: "לטיוטה אין קובץ PDF. הקובץ נשמר כשההזמנה מקבלת מספר." };
  const existing = await getOrderPdfFile(supabase, orgId, order.id).catch(() => null);
  if (existing) return { ok: true, fileId: existing.id };
  if (!orderPdfStorable(order)) return { ok: false, message: CLOSED };

  // the person's own session decides first (writable business, the flag, may edit the order's deal, contact or company)
  const allowed = await supabase.rpc("order_pdf_allowed", { p_org: orgId, p_order: order.id });
  if (allowed.error) return { ok: false, message: dbErrorMessage(allowed.error) };
  if (allowed.data !== true) return { ok: false, message: NOT_PERMITTED };

  const org = await supabase.from("organizations").select("name").eq("id", orgId).maybeSingle();
  if (org.error || !org.data) return { ok: false, message: NOT_MADE };
  const data = await getOrderDocumentData(orgId, order, org.data.name);
  const bytes = await renderPdf(orderPdfDocument(data, await loadPdfLogo(data.logoUrl)));

  const stored = await writeOrderPdfAsServer({ orgId, orderId: order.id, userId, bytes, name: orderPdfFileName(order.numberDisplay) });
  if (!stored.ok) return { ok: false, message: stored.busy ? IN_PROGRESS : stored.message };
  return { ok: true, fileId: stored.fileId };
}
