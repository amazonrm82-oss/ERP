import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DOCUMENT_EXPORT_HEADER, documentExportRows } from "@/features/documents/export-table";
import { DOCUMENT_DEFAULT_SORT, DOCUMENT_SORT_COLUMNS, documentListFilters, documentListHref, documentTotalsByType } from "@/features/documents/list";
import { catalogFor, resolveColumns } from "@/features/list-columns/columns";
import type { FilterTree } from "@/features/list-filters/model";
import { filterFields, filterToPostgrest } from "@/features/list-filters/server";
import { PAYMENT_EXPORT_HEADER, paymentExportRows } from "@/features/payments/export-table";
import { PAYMENT_DEFAULT_SORT, PAYMENT_SORT_COLUMNS, paymentListFilters, paymentListHref } from "@/features/payments/list";
import { VIEW_FILTER_KEYS, VIEW_OBJECTS } from "@/features/views/types";

// LST-09 for the money lists (owner, 21 October 2026): the accounting documents and the payments, each with its columns,
// sort, advanced filter, saved views, totals and export rows.

const ORG = "99999999-9999-4999-8999-999999999999";
const USER = "11111111-1111-4111-8111-111111111111";
const ctx = { userId: USER, now: new Date("2026-07-15T07:00:00Z") };
const lookups = { members: [{ value: USER, label: "דנה" }], tags: [], fields: [] };
const one = (field: string, op: string, value?: string): FilterTree => ({ match: "all", groups: [{ match: "all", conditions: [{ field, op, value }] }] });

describe("the documents list", () => {
  it("offers its columns, starts with a short set, and every column sorts", () => {
    const catalog = catalogFor("document", []);
    expect(catalog.map((c) => c.key)).toEqual(["type", "customer", "date", "amount", "status", "due", "recorder", "created"]);
    expect(resolveColumns("document", null, catalog).map((c) => c.key)).toEqual(["type", "customer", "date", "amount", "status"]);
    for (const key of ["name", ...catalog.map((column) => column.key)]) expect(Object.keys(DOCUMENT_SORT_COLUMNS), key).toContain(key);
  });

  it("reads its selects and sort from the address, never trusting them", () => {
    expect(documentListFilters({})).toEqual({ type: null, status: null, from: null, to: null, pay: null, customer: null, page: 1, sort: DOCUMENT_DEFAULT_SORT });
    const filters = documentListFilters({ type: "receipt", status: "active", from: "2026-08-01", to: "2026-07-01", sort: "-amount", page: "3" });
    expect(filters).toEqual({ type: "receipt", status: "active", from: "2026-07-01", to: "2026-08-01", pay: null, customer: null, page: 3, sort: { key: "amount", ascending: false } });
    expect(documentListFilters({ type: "invoice", status: "deleted", from: "yesterday", sort: "secret" })).toEqual(documentListFilters({}));
    expect(documentListHref(ORG, filters, 2, { f: '{"match":"all"}', sv: "v1" })).toBe(
      `/o/${ORG}/documents?type=receipt&status=active&from=2026-07-01&to=2026-08-01&sort=-amount&f=%7B%22match%22%3A%22all%22%7D&sv=v1&page=2`,
    );
    expect(documentListHref(ORG, documentListFilters({ sort: "-date" }))).toBe(`/o/${ORG}/documents`);
  });

  it("filters by checked values only, with no tags or custom fields", () => {
    const fields = filterFields("document", lookups);
    expect(fields.map((f) => f.key)).toEqual(["number", "type", "date", "amount", "status", "recorder", "created"]);
    expect(filterToPostgrest(one("type", "is", "credit_invoice"), fields, ctx).logic).toBe('and(and(doc_type.eq."credit_invoice"))');
    expect(filterToPostgrest(one("type", "is", "quote"), fields, ctx).logic).toBeNull();
    expect(filterToPostgrest(one("amount", "gt", "1000"), fields, ctx).logic).toBe("and(and(amount_agorot.gt.100000))");
    expect(filterToPostgrest(one("recorder", "is", "me"), fields, ctx).logic).toBe(`and(and(created_by.eq.${USER}))`);
    expect(filterToPostgrest(one("status", "is", "cancelled"), fields, ctx).logic).toBe('and(and(status.eq."cancelled"))');
  });

  it("totals per type, documents in force only, never netted", () => {
    const totals = documentTotalsByType([
      { docType: "tax_invoice", amountAgorot: 100_000, cancelled: false },
      { docType: "tax_invoice", amountAgorot: 50_000, cancelled: false },
      { docType: "credit_invoice", amountAgorot: 30_000, cancelled: false },
      { docType: "receipt", amountAgorot: 999_999, cancelled: true },
    ]);
    expect(Object.fromEntries(totals)).toEqual({ tax_invoice: { count: 2, agorot: 150_000 }, credit_invoice: { count: 1, agorot: 30_000 } });
  });

  it("GAP-12: opening debts and opening credits are two lines, never netted", () => {
    const totals = documentTotalsByType([
      { docType: "opening_balance", amountAgorot: 100_000, cancelled: false },
      { docType: "opening_balance", amountAgorot: -100_000, cancelled: false },
      { docType: "opening_balance", amountAgorot: -5_000, cancelled: false },
    ]);
    expect(Object.fromEntries(totals)).toEqual({ opening_debt: { count: 1, agorot: 100_000 }, opening_credit: { count: 2, agorot: 105_000 } });
  });

  it("exports one row per document in the header's order", () => {
    const rows = documentExportRows(
      [
        {
          docType: "tax_invoice",
          number: "1001",
          customer: "משה כהן",
          docDate: "2026-07-14",
          amountAgorot: 117_050,
          cancelled: false,
          createdBy: USER,
          // 23:30 UTC is the next day in Israel
          createdAt: "2026-07-14T23:30:00Z",
        },
        { docType: "credit_invoice", number: "7", customer: null, docDate: "2026-07-15", amountAgorot: 0, cancelled: true, createdBy: null, createdAt: "2026-07-15T08:00:00Z" },
      ],
      new Map([[USER, "דנה"]]),
      "Asia/Jerusalem",
    );
    expect(rows[0]).toHaveLength(DOCUMENT_EXPORT_HEADER.length);
    expect(rows[0]).toEqual(["חשבונית מס", "1001", "משה כהן", "2026-07-14", "1170.50", "בתוקף", "דנה", "2026-07-15"]);
    expect(rows[1]).toEqual(["חשבונית זיכוי", "7", "", "2026-07-15", "0.00", "בוטל", "", "2026-07-15"]);
  });
});

describe("the payments list", () => {
  it("offers its columns, starts with a short set, and every column sorts", () => {
    const catalog = catalogFor("payment", []);
    expect(catalog.map((c) => c.key)).toEqual(["customer", "date", "method", "installments", "reference", "status", "recorder", "created"]);
    expect(resolveColumns("payment", null, catalog).map((c) => c.key)).toEqual(["customer", "date", "method", "reference", "status"]);
    for (const key of ["name", ...catalog.map((column) => column.key)]) expect(Object.keys(PAYMENT_SORT_COLUMNS), key).toContain(key);
  });

  it("reads its selects and sort from the address, never trusting them", () => {
    expect(paymentListFilters({})).toEqual({ status: null, method: null, from: null, to: null, page: 1, sort: PAYMENT_DEFAULT_SORT });
    const filters = paymentListFilters({ status: "confirmed", method: "cheque", from: "2026-07-01", sort: "name" });
    expect(filters).toMatchObject({ status: "confirmed", method: "cheque", from: "2026-07-01", to: null, sort: { key: "name", ascending: true } });
    expect(paymentListFilters({ status: "paid", method: "gold" })).toEqual(paymentListFilters({}));
    expect(paymentListHref(ORG, filters)).toBe(`/o/${ORG}/payments?status=confirmed&method=cheque&from=2026-07-01&sort=name`);
    expect(paymentListHref(ORG, paymentListFilters({ sort: "-date" }))).toBe(`/o/${ORG}/payments`);
  });

  it("filters by checked values only; the note is not a field", () => {
    const fields = filterFields("payment", lookups);
    expect(fields.map((f) => f.key)).toEqual(["amount", "date", "method", "installments", "reference", "status", "recorder", "created"]);
    expect(filterToPostgrest(one("method", "is", "bit_paybox"), fields, ctx).logic).toBe('and(and(method.eq."bit_paybox"))');
    expect(filterToPostgrest(one("status", "is", "refunded"), fields, ctx).logic).toBe('and(and(status.eq."refunded"))');
    expect(filterToPostgrest(one("status", "is", "paid"), fields, ctx).logic).toBeNull();
    expect(filterToPostgrest(one("reference", "contains", "A-12"), fields, ctx).logic).toBe('and(and(reference.ilike."*A-12*"))');
  });

  it("exports one row per payment in the header's order", () => {
    const rows = paymentExportRows(
      [
        {
          amountAgorot: 50_000,
          customer: "רות לוי",
          paidOn: "2026-07-14",
          method: "credit",
          installments: 3,
          reference: "A-12",
          status: "confirmed",
          createdBy: USER,
          createdAt: "2026-07-14T08:00:00Z",
        },
        { amountAgorot: 1, customer: null, paidOn: "2026-07-15", method: "cash", installments: null, reference: null, status: "cancelled", createdBy: null, createdAt: "2026-07-15T08:00:00Z" },
      ],
      new Map([[USER, "דנה"]]),
      "Asia/Jerusalem",
    );
    expect(rows[0]).toHaveLength(PAYMENT_EXPORT_HEADER.length);
    expect(rows[0]).toEqual(["500.00", "רות לוי", "2026-07-14", "כרטיס אשראי", "3", "A-12", "אושר", "דנה", "2026-07-14"]);
    expect(rows[1]).toEqual(["0.01", "", "2026-07-15", "מזומן", "", "", "בוטל", "", "2026-07-15"]);
  });
});

describe("saved views and the database's lists", () => {
  it("are lists of their own and keep their own selects", () => {
    expect(VIEW_OBJECTS).toEqual(expect.arrayContaining(["document", "payment"]));
    expect(VIEW_FILTER_KEYS).toEqual(expect.arrayContaining(["type", "status", "method", "from", "to", "f"]));
  });

  it("the object types match the list_preferences and saved_views constraints", () => {
    const dir = new URL("../../supabase/migrations/", import.meta.url);
    const sql = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => readFileSync(new URL(name, dir), "utf8"))
      .filter((text) => text.includes("saved_views_object_type_check"))
      .at(-1) ?? "";
    const views = /saved_views_object_type_check\s+check \(object_type in \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    expect([...views.matchAll(/'([^']*)'/g)].map((m) => m[1])).toEqual([...VIEW_OBJECTS]);
  });
});
