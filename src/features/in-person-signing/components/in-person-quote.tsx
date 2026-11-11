"use client";

import { QuoteAnswerArea } from "@/features/quotes/components/quote-answer-area";
import type { DecisionReply } from "@/features/quotes/components/quote-decision-panel";
import type { QuoteLine } from "@/features/quotes/queries";

import { acceptQuoteInPersonAction } from "../actions";
import { IN_PERSON_EVIDENCE } from "../texts";
import { InPersonDone } from "./in-person-done";

type Props = {
  orgId: string;
  quoteId: string;
  fingerprint: string;
  quote: { vatRateBp: number | null; pricesIncludeVat: boolean; discountBp: number | null; discountAgorot: number | null };
  lines: QuoteLine[];
  back: { href: string; label: string };
};

type Reply = DecisionReply & { pdfLater?: boolean };

/** SGN-07: the customer's acceptance of a quote, signed in person on the rep's device (optional lines as on its page). */
export function InPersonQuoteAccept({ orgId, quoteId, fingerprint, quote, lines, back }: Props) {
  async function send(body: unknown): Promise<Reply> {
    const result = await acceptQuoteInPersonAction(orgId, quoteId, body);
    if (!result.ok) return { ok: false, message: result.message };
    const data = result.data;
    if (!data) return { ok: false, message: "משהו השתבש. נסו שוב בעוד רגע." };
    return { ok: data.signed, status: data.status, message: data.message, pdfLater: data.pdfLater };
  }
  return (
    <QuoteAnswerArea
      fingerprint={fingerprint}
      quote={quote}
      lines={lines}
      inPerson={{
        send,
        evidence: IN_PERSON_EVIDENCE,
        done: (reply) => <InPersonDone message={reply.message} pdfLater={(reply as Reply).pdfLater === true} back={back} />,
      }}
    />
  );
}
