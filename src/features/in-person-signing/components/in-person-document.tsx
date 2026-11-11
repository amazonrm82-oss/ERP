"use client";

import { SignPanel, type SignReply } from "@/features/signatures/components/sign-panel";

import { signDocumentInPersonAction } from "../actions";
import { IN_PERSON_EVIDENCE } from "../texts";
import { InPersonDone } from "./in-person-done";

type Props = { orgId: string; docId: string; fingerprint: string; back: { href: string; label: string } };

type Reply = SignReply & { pdfLater?: boolean };

/** SGN-07: the signing box of a document for signature, signed in person on the rep's device (the rep's action). */
export function InPersonDocumentSign({ orgId, docId, fingerprint, back }: Props) {
  async function send(body: unknown): Promise<Reply> {
    const result = await signDocumentInPersonAction(orgId, docId, body);
    if (!result.ok) return { ok: false, message: result.message };
    const data = result.data;
    if (!data) return { ok: false, message: "משהו השתבש. נסו שוב בעוד רגע." };
    return { ok: data.signed, status: data.status, message: data.message, pdfLater: data.pdfLater };
  }
  return (
    <SignPanel
      fingerprint={fingerprint}
      send={send}
      evidence={IN_PERSON_EVIDENCE}
      done={(reply) => <InPersonDone message={reply.message} pdfLater={(reply as Reply).pdfLater === true} back={back} />}
    />
  );
}
