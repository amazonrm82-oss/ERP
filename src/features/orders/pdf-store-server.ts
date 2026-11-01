import "server-only";

import { FILES_BUCKET } from "@/features/files/types";
import { sha256Hex, storeAnswerFrom } from "@/features/quotes/pdf-fingerprint";
import { dbErrorMessage } from "@/lib/errors";
import { createServiceClient } from "@/lib/supabase/service";

// ORD-05 PDF (owner, 1 November 2026, answer (1) ב; CLAUDE.md hard rule 5, QUO-06's pattern): the server alone writes an
// order's PDF. The caller (pdf-server.ts) has already checked the person's right with their own session
// (public.order_pdf_allowed) and rendered the file. Here, with the service key, and nothing else: public.order_pdf_store
// (service_role only; it checks the user again, takes the quota and answers this attempt's own path), the upload of the bytes
// to exactly that path with upsert off, and the same function again naming that path, which confirms the row once the object
// is there.

export type ServerStoreResult = { ok: true; fileId: string } | { ok: false; message: string; busy?: boolean };

const NOT_MADE = "קובץ ה-PDF לא נשמר. נסו שוב בעוד רגע.";
const NOT_PERMITTED = "אין לכם הרשאה לשמור את קובץ ה-PDF של ההזמנה הזאת.";

export async function writeOrderPdfAsServer(input: { orgId: string; orderId: string; userId: string; bytes: Uint8Array; name: string }): Promise<ServerStoreResult> {
  const service = createServiceClient();
  if (!service) return { ok: false, message: NOT_MADE };
  const args = {
    p_org: input.orgId,
    p_order: input.orderId,
    p_user: input.userId,
    p_size: input.bytes.length,
    p_sha256: sha256Hex(input.bytes),
    p_name: input.name,
  };
  type Asked = { error: { code?: string; message: string }; answer?: undefined } | { error: null; answer: ReturnType<typeof storeAnswerFrom> };
  const ask = async (path: string | null): Promise<Asked> => {
    const { data, error } = await service.rpc("order_pdf_store", { ...args, p_path: path });
    if (error) return { error };
    return { error: null, answer: storeAnswerFrom(data, input.orgId) };
  };

  const first = await ask(null);
  if (first.error) {
    if (first.error.code === "42501") return { ok: false, message: NOT_PERMITTED };
    return { ok: false, message: dbErrorMessage(first.error, NOT_MADE) };
  }
  if (!first.answer) return { ok: false, message: NOT_MADE };
  if (first.answer.status === "stored") return { ok: true, fileId: first.answer.fileId };
  if (first.answer.status === "busy") return { ok: false, message: NOT_MADE, busy: true };

  // only the path the database named for this attempt, never over an existing object
  const path = first.answer.path;
  const upload = await service.storage.from(FILES_BUCKET).upload(path, input.bytes, { contentType: "application/pdf", upsert: false });
  // the second call names this attempt's path: it confirms only that path, and queues it for the cleanup when the row has
  // moved on (a takeover meanwhile); after a failed upload it answers the path again and nothing is confirmed
  const second = await ask(path);
  if (!second.error && second.answer?.status === "stored") return { ok: true, fileId: second.answer.fileId };
  if (upload.error) return { ok: false, message: NOT_MADE };
  if (second.error) return { ok: false, message: dbErrorMessage(second.error, NOT_MADE) };
  return { ok: false, message: NOT_MADE, busy: second.answer?.status === "busy" };
}
