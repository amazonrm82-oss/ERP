import { orderPath } from "@/features/orders/paths";
import { paths } from "@/lib/paths";

// DOC-01 / PAY-01, and ORD-06 part two: the page a document or payment card sits on: a deal, a contact, or a numbered order
// (its documents and payments carry order_id and hang on the order's own deal or contact). Shared by both cards, their
// actions and the files on them.

export const MONEY_SUBJECT_KINDS = ["deal", "contact", "order"] as const;
export type MoneySubject = { kind: (typeof MONEY_SUBJECT_KINDS)[number]; id: string };

/** The column a card's rows are listed by. */
export const MONEY_SUBJECT_COLUMN = { deal: "deal_id", contact: "contact_id", order: "order_id" } as const;

/** The page to revalidate after a change. */
export function moneySubjectPath(orgId: string, subject: MoneySubject): string {
  return subject.kind === "deal" ? paths.deal(orgId, subject.id) : subject.kind === "contact" ? paths.contact(orgId, subject.id) : orderPath(orgId, subject.id);
}
