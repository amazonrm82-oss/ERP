import { z } from "zod";

/**
 * TAX-02, the rest: the business's bank details for a transfer, as a document shows them. A quote stores
 * app.document_bank_snapshot() when it is sent and an order when it is numbered (`bank_details`); a document
 * shows that snapshot, never the live settings, and only while the design shows it (quote_designs.show_bank_details).
 * Pure, so the document, the customer page and the PDF share one wording.
 */
export type DocumentBank = {
  bankName: string | null;
  branch: string | null;
  account: string;
  accountName: string | null;
};

const text = z.string().nullish().transform((value) => (value && value.trim() !== "" ? value.trim() : null));

export const bankSnapshotSchema = z.object({
  bank_name: text,
  bank_branch: text,
  bank_account: text,
  bank_account_name: text,
});

/** A stored snapshot (or the customer page's `bank`) as a document shows it; anything without an account is none. */
export function bankFromSnapshot(value: unknown): DocumentBank | null {
  const parsed = bankSnapshotSchema.safeParse(value);
  if (!parsed.success || !parsed.data.bank_account) return null;
  return {
    bankName: parsed.data.bank_name,
    branch: parsed.data.bank_branch,
    account: parsed.data.bank_account,
    accountName: parsed.data.bank_account_name,
  };
}

export const BANK_HEADING = "פרטים להעברה בנקאית";

/** The block's rows as label and value; numbers stay numbers (the screen and the PDF keep them left to right). */
export function bankRows(bank: DocumentBank): Array<{ label: string; value: string; number: boolean }> {
  const rows: Array<{ label: string; value: string; number: boolean }> = [];
  if (bank.bankName) rows.push({ label: "בנק", value: bank.bankName, number: false });
  if (bank.branch) rows.push({ label: "סניף", value: bank.branch, number: true });
  rows.push({ label: "מספר חשבון", value: bank.account, number: true });
  if (bank.accountName) rows.push({ label: "על שם", value: bank.accountName, number: false });
  return rows;
}
