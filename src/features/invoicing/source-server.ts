import "server-only";

import { moneySubjectPath } from "@/features/payments/money-subject";
import { quotePath } from "@/features/quotes/paths";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { agorotText, EMPTY_ISSUE_LINE, sourceLineDiscount, type IssueLineDraft, type IssueSourceKind } from "./issue";

// DOC-07: what the issue page starts from: the source's lines (editable on the page), its VAT mode and the customer the
// document will name with what is missing (DOC-08), all read with the user's session. The database judges everything
// again when the person presses "הפקה".

export type IssueCustomer = { name: string | null; taxId: string | null; address: string | null; email: string | null; isBusiness: boolean; problems: string[] };

export type IssueSource = {
  kind: IssueSourceKind;
  id: string;
  title: string;
  backHref: string;
  customer: IssueCustomer;
  lines: IssueLineDraft[];
  pricesIncludeVat: boolean;
};

type SourceLine = {
  description: string;
  quantity: number;
  unit_price_agorot: number;
  discount_bp: number | null;
  discount_agorot: number | null;
  vat_exempt: boolean;
  product_id?: string | null;
};

const draftOf = (line: SourceLine): IssueLineDraft => ({
  description: line.description.trim().slice(0, 500),
  quantity: String(Number(line.quantity)),
  unitPrice: agorotText(line.unit_price_agorot),
  discount: (() => {
    const discount = sourceLineDiscount(line);
    return discount > 0 ? agorotText(discount) : "";
  })(),
  vatExempt: line.vat_exempt,
  productId: line.product_id ?? null,
});

const KIND_TITLE: Record<IssueSourceKind, string> = { deal: "עסקה", contact: "איש קשר", quote: "הצעת מחיר", order: "הזמנה" };

/** The source, or null when it is not found for this person (the page answers not found). */
export async function getIssueSource(orgId: string, kind: IssueSourceKind, id: string): Promise<IssueSource | null> {
  const supabase = await createClient();
  const { data: customerData, error } = await supabase.rpc("invoice_issue_customer", { p_org: orgId, p_kind: kind, p_id: id });
  if (error) {
    if (error.code === "42501" || error.hint === "invoice:source" || error.hint === "invoice:order_cancelled" || error.hint === "feature:documents") return null;
    throw new Error(`invoice_issue_customer: ${error.message}`);
  }
  const answer = (customerData ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof answer[key] === "string" ? (answer[key] as string) : null);
  const customer: IssueCustomer = {
    name: text("name"),
    taxId: text("tax_id"),
    address: text("address"),
    email: text("email"),
    isBusiness: answer.is_business === true,
    problems: Array.isArray(answer.problems) ? answer.problems.filter((p): p is string => typeof p === "string") : [],
  };

  let title = KIND_TITLE[kind];
  let lines: IssueLineDraft[] = [];
  let pricesIncludeVat = false;
  if (kind === "deal") {
    const deal = must(await supabase.from("deals").select("name").eq("organization_id", orgId).eq("id", id).maybeSingle(), "deal");
    if (deal) title = `${title}: ${deal.name}`;
    const rows = must(
      await supabase
        .from("deal_lines")
        .select("description, quantity, unit_price_agorot, discount_bp, discount_agorot, vat_exempt, price_includes_vat, product_id")
        .eq("organization_id", orgId)
        .eq("deal_id", id)
        .order("position")
        .limit(200),
      "deal lines",
    );
    lines = rows.map(draftOf);
    pricesIncludeVat = rows.some((row) => row.price_includes_vat);
  } else if (kind === "quote" || kind === "order") {
    const head = must(
      await supabase
        .from(kind === "quote" ? "quotes" : "orders")
        .select("number_display, prices_include_vat")
        .eq("organization_id", orgId)
        .eq("id", id)
        .maybeSingle(),
      kind,
    );
    if (head?.number_display) title = `${title} ${head.number_display}`;
    pricesIncludeVat = head?.prices_include_vat === true;
    if (kind === "quote") {
      const rows = must(
        await supabase
          .from("quote_lines")
          .select("kind, name, description, quantity, unit_price_agorot, discount_bp, discount_agorot, vat_exempt, is_optional, optional_selected, product_id")
          .eq("organization_id", orgId)
          .eq("quote_id", id)
          .order("position")
          .limit(200),
        "quote lines",
      );
      lines = rows
        .filter((row) => row.kind === "item" && (!row.is_optional || row.optional_selected))
        .map((row) => draftOf({ ...row, description: row.name }));
    } else {
      const rows = must(
        await supabase
          .from("order_lines")
          .select("kind, name, quantity, unit_price_agorot, discount_bp, discount_agorot, vat_exempt, product_id")
          .eq("organization_id", orgId)
          .eq("order_id", id)
          .order("position")
          .limit(200),
        "order lines",
      );
      lines = rows.filter((row) => row.kind === "item").map((row) => draftOf({ ...row, description: row.name }));
    }
  } else {
    title = customer.name ? `${title}: ${customer.name}` : title;
  }
  if (lines.length === 0) lines = [{ ...EMPTY_ISSUE_LINE }];
  const backHref = kind === "quote" ? quotePath(orgId, id) : moneySubjectPath(orgId, { kind, id });
  return { kind, id, title, backHref, customer, lines, pricesIncludeVat };
}
