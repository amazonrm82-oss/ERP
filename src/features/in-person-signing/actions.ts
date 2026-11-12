"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { readQuote } from "@/features/quotes/queries";
import { quotePath } from "@/features/quotes/paths";
import { storeSignedQuotePdf } from "@/features/quotes/pdf-server";
import { ACCEPT_WORDING_VERSION, decisionBodySchema, DECISION_MESSAGES, isDecisionStatus } from "@/features/quotes/decision";
import { signaturePng } from "@/features/quotes/signed-pdf";
import { readSignedDocumentSource } from "@/features/signatures/pdf";
import { writeSignedDocumentPdfAsServer } from "@/features/signatures/pdf-server";
import { isSignStatus, SIGN_MESSAGES, SIGN_WORDING_VERSION, signBodySchema } from "@/features/signatures/public";
import { actionContext } from "@/lib/action-context";
import { clientIp } from "@/lib/keyed-ip-hash";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { serverLog } from "@/lib/log-server";

import { IN_PERSON_CANNOT, IN_PERSON_DECLINED, recordPathOf, type InPersonResult } from "./texts";

// SGN-07 (owner, 11 November 2026, answer (276) א): the customer signs on the rep's device. Everything goes through the rep's
// own session: the database checks first that the rep may send the document (or quote), records the signature as face to
// face with the rep's identity and the rep's device (the user agent and, owner (287) ב, the device's IP address), and only then is the signed PDF made, by the
// existing writer, asked for with the same session (public.signature_in_person_pdf_allowed / quote_in_person_pdf_allowed)
// and written for that rep, whom the writer checks again. A PDF that fails never undoes the signature: owners and admins
// make it later from the record, as after a signature through the customer's link.

async function deviceUserAgent(): Promise<string | null> {
  return (await headers()).get("user-agent")?.slice(0, 500) ?? null;
}

// Owner (287) ב: the IP address of the rep's device, read from the request exactly as the public sign route reads the
// customer's (clientIp), handed to the database in this header (app.in_person_device_ip; empty or malformed = none kept)
const DEVICE_IP_HEADER = "x-crm-device-ip";
async function deviceIp(): Promise<string> {
  return clientIp(await headers())?.slice(0, 64) ?? "";
}

const rpcError = (error: { code?: string; message?: string; hint?: string }) => (error.code === "42501" ? IN_PERSON_CANNOT : dbErrorMessage(error));

/** A document for signature, signed by the customer on the rep's device. */
export async function signDocumentInPersonAction(orgId: string, docId: string, body: unknown): Promise<ActionResult<InPersonResult>> {
  const parsed = signBodySchema.safeParse(body);
  if (!parsed.success) return fail(SIGN_MESSAGES.invalid);
  const sign = parsed.data;
  // the drawn image passes the same PNG checks as on the customer's page, before the database
  if (sign.signatureKind === "drawn" && (!sign.signatureImage || signaturePng(sign.signatureImage) === null)) return fail(SIGN_MESSAGES.invalid);
  const context = await actionContext(orgId, docId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("signature_in_person_sign", {
    p_org: orgId,
    p_doc: docId,
    p_fingerprint: sign.fingerprint,
    p_signer_name: sign.signerName,
    p_id_number: sign.idNumber || null,
    p_signature_kind: sign.signatureKind,
    p_signature_image: sign.signatureKind === "drawn" ? sign.signatureImage : null,
    p_wording_version: SIGN_WORDING_VERSION,
    p_agreed: sign.agreed,
    p_user_agent: await deviceUserAgent(),
  }).setHeader(DEVICE_IP_HEADER, await deviceIp());
  if (error) return fail(rpcError(error));
  const status = (data as { status?: unknown } | null)?.status;
  if (!isSignStatus(status)) return fail("משהו השתבש. נסו שוב בעוד רגע.");
  if (status !== "signed") return ok({ status, signed: false, message: SIGN_MESSAGES[status], pdfLater: false });

  // the record's page shows the new state
  const doc = await context.supabase
    .from("signature_documents")
    .select("lead_id, contact_id, company_id, deal_id")
    .eq("organization_id", orgId)
    .eq("id", docId)
    .maybeSingle();
  if (!doc.error && doc.data) {
    const path = recordPathOf(orgId, doc.data);
    if (path) revalidatePath(path);
  }

  let pdfLater = true;
  try {
    const allowed = await context.supabase.rpc("signature_in_person_pdf_allowed", { p_org: orgId, p_doc: docId });
    if (!allowed.error && allowed.data !== null) {
      const read = readSignedDocumentSource(allowed.data);
      if (!("problem" in read)) {
        const stored = await writeSignedDocumentPdfAsServer({ orgId, docId, userId: context.user.id, source: read.source });
        pdfLater = !stored.ok;
      }
    } else if (!allowed.error) {
      pdfLater = false;
    }
  } catch (err) {
    void serverLog("error", "signature.in_person_pdf_failed", { error_name: err instanceof Error ? err.name : "error" });
  }
  return ok({ status, signed: true, message: SIGN_MESSAGES.signed, pdfLater });
}

/** A quote, accepted and signed (or, owner (290) ב, declined) by the customer on the rep's device. */
export async function acceptQuoteInPersonAction(orgId: string, quoteId: string, body: unknown): Promise<ActionResult<InPersonResult>> {
  const parsed = decisionBodySchema.safeParse(body);
  if (!parsed.success) return fail(DECISION_MESSAGES.invalid);
  if (parsed.data.decision === "rejected") return declineQuoteInPerson(orgId, quoteId, parsed.data.fingerprint, parsed.data.reason);
  const accept = parsed.data;
  if (accept.signatureKind === "drawn" && (!accept.signatureImage || signaturePng(accept.signatureImage) === null)) return fail(DECISION_MESSAGES.invalid);
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("quote_in_person_accept", {
    p_org: orgId,
    p_quote: quoteId,
    p_fingerprint: accept.fingerprint,
    p_signer_name: accept.signerName,
    p_id_number: accept.idNumber || null,
    p_signature_kind: accept.signatureKind,
    p_signature_image: accept.signatureKind === "drawn" ? accept.signatureImage : null,
    p_wording_version: ACCEPT_WORDING_VERSION,
    p_agreed: accept.agreed,
    p_user_agent: await deviceUserAgent(),
    p_optional_keys: accept.optionalKeys ?? null,
    p_accepted_total_agorot: accept.acceptedTotalAgorot ?? null,
  }).setHeader(DEVICE_IP_HEADER, await deviceIp());
  if (error) return fail(rpcError(error));
  const status = (data as { status?: unknown } | null)?.status;
  if (!isDecisionStatus(status)) return fail("משהו השתבש. נסו שוב בעוד רגע.");
  if (status !== "accepted") return ok({ status, signed: false, message: DECISION_MESSAGES[status], pdfLater: false });
  revalidatePath(quotePath(orgId, quoteId));

  let pdfLater = true;
  try {
    const quote = await readQuote(context.supabase, orgId, quoteId);
    if (quote) {
      const pdf = await storeSignedQuotePdf(context.supabase, orgId, quote, context.user.id, "in_person");
      pdfLater = !pdf.ok;
    }
  } catch (err) {
    void serverLog("error", "quote_signed_pdf.in_person_failed", { error_name: err instanceof Error ? err.name : "error" });
  }
  return ok({ status, signed: true, message: DECISION_MESSAGES.accepted, pdfLater });
}

/** Owner (290) ב: the customer declines the quote on the rep's device (public.quote_in_person_decline, the rep's session). */
async function declineQuoteInPerson(orgId: string, quoteId: string, fingerprint: string, reason: string | null): Promise<ActionResult<InPersonResult>> {
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .rpc("quote_in_person_decline", {
      p_org: orgId,
      p_quote: quoteId,
      p_fingerprint: fingerprint,
      p_decline_reason: reason || null,
      p_user_agent: await deviceUserAgent(),
    })
    .setHeader(DEVICE_IP_HEADER, await deviceIp());
  if (error) return fail(rpcError(error));
  const status = (data as { status?: unknown } | null)?.status;
  if (!isDecisionStatus(status)) return fail("משהו השתבש. נסו שוב בעוד רגע.");
  if (status !== "rejected") return ok({ status, signed: false, message: DECISION_MESSAGES[status], pdfLater: false });
  revalidatePath(quotePath(orgId, quoteId));
  return ok({ status, signed: false, declined: true, message: IN_PERSON_DECLINED, pdfLater: false });
}
