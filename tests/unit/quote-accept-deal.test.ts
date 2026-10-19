import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { linesKeptText, offersDealMove, quoteWinResult, QUOTE_ACCEPT_DEAL_DEFAULT, QUOTE_ACCEPT_DEAL_MODES, QUOTE_ACCEPT_DEAL_OPTIONS, quoteAcceptDealOf } from "@/features/quotes/accept-deal";

describe("QUO-13: what an accepted quote does to its deal", () => {
  it("the modes and the default match the migration's check and default", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const sql = readFileSync(join(dir, "20261006020485_quote_accept_deal.sql"), "utf8");
    expect(sql).toContain(`quote_accept_deal text not null default '${QUOTE_ACCEPT_DEAL_DEFAULT}'`);
    expect(sql).toContain(`check (quote_accept_deal in (${QUOTE_ACCEPT_DEAL_MODES.map((m) => `'${m}'`).join(", ")}))`);
    expect(QUOTE_ACCEPT_DEAL_OPTIONS.map((o) => o.value).sort()).toEqual([...QUOTE_ACCEPT_DEAL_MODES].sort());
    expect(quoteAcceptDealOf(undefined)).toBe("ask");
    expect(quoteAcceptDealOf("auto")).toBe("auto");
    expect(quoteAcceptDealOf("always")).toBe("ask");
  });

  it("the quote page offers the move only for an accepted quote with an open deal, not an addendum, unless 'none'", () => {
    const base = { status: "accepted", hasDeal: true, isAddendum: false, dealOpen: true, mode: "ask" as const, canEdit: true };
    expect(offersDealMove(base)).toBe(true);
    // an automatic step that failed leaves the deal open: the page offers the move too
    expect(offersDealMove({ ...base, mode: "auto" })).toBe(true);
    expect(offersDealMove({ ...base, mode: "none" })).toBe(false);
    expect(offersDealMove({ ...base, status: "sent" })).toBe(false);
    expect(offersDealMove({ ...base, hasDeal: false })).toBe(false);
    expect(offersDealMove({ ...base, isAddendum: true })).toBe(false);
    expect(offersDealMove({ ...base, dealOpen: false })).toBe(false);
    expect(offersDealMove({ ...base, canEdit: false })).toBe(false);
  });

  it("the won window says why the lines were kept, and the automatic mode's help says what it skips", () => {
    expect(linesKeptText("deal_lines:vat_mode")).toMatch(/^העסקה עברה לזכייה, אבל השורות שלה לא עודכנו לפי ההצעה: .+מע"מ/);
    expect(linesKeptText("deal_lines:product")).toContain("כבר לא מוצע");
    expect(linesKeptText("feature:discounts")).toContain("לחבילה");
    expect(linesKeptText("deal_lines:max")).toContain("כללים");
    const auto = QUOTE_ACCEPT_DEAL_OPTIONS.find((o) => o.value === "auto")!.description;
    expect(auto).toContain("שדות החובה");
    expect(auto).toContain("משימת קליטה");
  });

  it("the won window's save follows only the deal it was opened for", () => {
    const deal = "11111111-1111-4111-8111-111111111111";
    expect(quoteWinResult({ deal, lines: "updated" }, deal)).toEqual({ deal, linesHint: null });
    expect(quoteWinResult({ deal, lines: "deal_lines:vat_mode" }, deal)).toEqual({ deal, linesHint: "deal_lines:vat_mode" });
    expect(quoteWinResult({ deal: "22222222-2222-4222-8222-222222222222", lines: "updated" }, deal)).toBeNull();
    expect(quoteWinResult({ lines: "updated" }, deal)).toBeNull();
    expect(quoteWinResult(null, deal)).toBeNull();
    expect(quoteWinResult([deal], deal)).toBeNull();
  });
});
