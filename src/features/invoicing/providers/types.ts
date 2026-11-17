// DOC-06: one interface for every invoice provider (Morning, iCount, SUMIT, EZcount, Rivhit, spec 6.6). A module that issues,
// reads or credits a document talks only to this interface; adding a provider is one adapter file plus one line in
// select.ts, and no module changes. Only the fake adapter exists until the owner chooses a provider (owner (270) (1) א).
//
// Money is integer agorot, quantities at most 3 decimals, dates YYYY-MM-DD in the business's zone. A provider never decides
// what the business owes: the database computes the totals (app.document_totals) and the adapter hands them on as they are.

/** The documents a provider issues from this system (spec 6.4). A credit invoice goes through creditDocument (DOC-14). */
export const ISSUABLE_DOCUMENT_TYPES = ["tax_invoice", "tax_invoice_receipt", "receipt", "proforma"] as const;
export type IssuableDocumentType = (typeof ISSUABLE_DOCUMENT_TYPES)[number];

/** Every type a provider may report (issue, credit, or a document made directly at the provider, DOC-11). */
export type ProviderDocumentType = IssuableDocumentType | "credit_invoice";

export type InvoiceLocale = "he" | "en";

/** The customer as the document names them (DOC-08 checked it before the provider is asked). */
export type InvoiceCustomer = {
  /** Our id (a contact, else a company): the provider keeps it so the next document finds the same customer (DOC-13). */
  externalRef: string;
  name: string;
  taxId: string | null;
  address: string | null;
  email: string | null;
  isBusiness: boolean;
};

export type InvoiceLine = {
  description: string;
  quantity: number;
  unitPriceAgorot: number;
  /** off the line, before VAT is worked out (as app.document_totals takes it) */
  discountAgorot: number;
  vatExempt: boolean;
};

export type InvoiceTotals = {
  netAgorot: number;
  vatAgorot: number;
  totalAgorot: number;
  rateBp: number;
  pricesIncludeVat: boolean;
};

export type IssueRequest = {
  /**
   * DOC-09: one key per request. The same key twice (a double click, a retry after a network failure) answers the
   * document the first call made, never a second one.
   */
  idempotencyKey: string;
  type: IssuableDocumentType;
  date: string;
  dueDate: string | null;
  locale: InvoiceLocale;
  /** The provider emails the document to the customer (DOC-05 default, DOC-15). */
  sendEmail: boolean;
  customer: InvoiceCustomer;
  /**
   * DOC-13: the customer's id at the provider, from an earlier upsertCustomer made with these same details; null = the
   * provider finds the customer by `customer.externalRef` (the worker upserts first whenever the details changed).
   */
  providerCustomerId?: string | null;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
};

/**
 * DOC-10: why a provider did not get an allocation number, as one code of a CLOSED list (the database keeps only these:
 * app.allocation_failure_codes(), constraint accounting_documents_allocation_failure_shape). An adapter maps its provider's
 * own errors onto them; anything it cannot place is "other". "invalid_number" is the system's own: the provider said it got
 * a number that is not digits.
 */
export const ALLOCATION_FAILURE_CODES = [
  "tax_authority_refused",
  "tax_authority_unavailable",
  "customer_tax_id",
  "business_not_authorized",
  "invalid_number",
  "other",
] as const;
export type AllocationFailureCode = (typeof ALLOCATION_FAILURE_CODES)[number];
export const isAllocationFailureCode = (value: unknown): value is AllocationFailureCode =>
  typeof value === "string" && (ALLOCATION_FAILURE_CODES as readonly string[]).includes(value);

/**
 * DOC-10: the allocation outcome of an issued document. Whether a document needs a number (the Tax Authority's threshold)
 * is the provider's call only (spec 6.7): the system never works it out, it keeps what the provider answered.
 */
export type AllocationOutcome =
  | { status: "allocated"; number: string }
  | { status: "failed"; code: AllocationFailureCode }
  | { status: "not_needed" };

export type ProviderDocument = {
  providerDocumentId: string;
  type: ProviderDocumentType;
  number: string;
  date: string;
  totalAgorot: number;
  /** DOC-10: the Tax Authority's allocation number, its failure with a code, or none needed (the provider's word) */
  allocation: AllocationOutcome;
  /** The customer's ref as we sent it (DOC-11 matching), when the provider keeps it */
  customerRef: string | null;
};

/**
 * Why a call did not succeed. `retry` = nothing is known to have happened at the provider (a timeout before the answer, a
 * throttle, a 5xx): the same request may be sent again with the same idempotency key. `refused` = the provider said no
 * (bad details, no permission); `auth` = the stored key was refused (the connection needs a new key, DOC-16).
 */
export type ProviderFailure = { ok: false; kind: "retry" | "refused" | "auth"; code: string };
export type ProviderResult<T> = ({ ok: true } & T) | ProviderFailure;

export type CreditRequest = {
  idempotencyKey: string;
  originalProviderDocumentId: string;
  date: string;
  reason: string;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
};

/** DOC-06's interface. Every method answers a result; none throws on a provider's refusal. */
export interface InvoiceProvider {
  /** The provider code stored with each document (accounting_documents.provider, `^[a-z][a-z0-9_]{1,39}$`) */
  readonly name: string;
  /** DOC-05: the connection works (the key is accepted) */
  checkConnection(): Promise<ProviderResult<object>>;
  /** DOC-13: the customer at the provider, made or updated; its id there */
  upsertCustomer(customer: InvoiceCustomer): Promise<ProviderResult<{ providerCustomerId: string }>>;
  issueDocument(request: IssueRequest): Promise<ProviderResult<{ document: ProviderDocument }>>;
  getDocument(providerDocumentId: string): Promise<ProviderResult<{ document: ProviderDocument }>>;
  /**
   * DOC-09: the document an earlier issueDocument made with this idempotency key, if any. A lookup only: it never issues.
   * Not found = `{ok: false, kind: "refused", code: "not_found"}`.
   */
  findDocument(idempotencyKey: string): Promise<ProviderResult<{ document: ProviderDocument }>>;
  /** DOC-11 / DOC-12: documents from a date on (sync and history) */
  listDocumentsSince(date: string): Promise<ProviderResult<{ documents: ProviderDocument[] }>>;
  /** DOC-14: a credit invoice that refers to the original */
  creditDocument(request: CreditRequest): Promise<ProviderResult<{ document: ProviderDocument }>>;
  /** A link to the document's PDF at the provider, for a short time */
  pdfLink(providerDocumentId: string): Promise<ProviderResult<{ url: string }>>;
  /** DOC-11: a webhook's signature; false when it does not hold (the body is then never read further) */
  verifyWebhook(body: string, headers: Record<string, string | undefined>): Promise<boolean>;
}
