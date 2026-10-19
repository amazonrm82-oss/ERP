import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ContactFields } from "@/features/contacts/components/contact-fields";
import { DEFAULT_MODULES, modulesFromRow } from "@/features/modules/modules";
import { REPORTS } from "@/features/reports/definitions";
import { createItems, navItems } from "@/features/shell/nav";
import { dbErrorMessage } from "@/lib/errors";

// LEAD-08 part (a): switching a module off hides it in the app; nothing is removed.
describe("module switches (LEAD-08)", () => {
  it("no row, or a missing value, is on; the stored row is read as it is", () => {
    expect(modulesFromRow(null)).toEqual(DEFAULT_MODULES);
    expect(modulesFromRow({})).toEqual({ leads: true, companies: true });
    expect(modulesFromRow({ leads_enabled: false, companies_enabled: true })).toEqual({ leads: false, companies: true });
    expect(modulesFromRow({ leads_enabled: true, companies_enabled: false })).toEqual({ leads: true, companies: false });
  });

  it("the migration's defaults are on, like the app's", () => {
    const sql = readFileSync(path.resolve(__dirname, "../../supabase/migrations/20261006020460_org_modules.sql"), "utf8");
    expect(sql).toMatch(/leads_enabled\s+boolean not null default true/);
    expect(sql).toMatch(/companies_enabled\s+boolean not null default true/);
  });

  it("the menu leaves out a switched-off module; with leads off contacts take the bottom-bar place", () => {
    const keys = (modules = DEFAULT_MODULES) => navItems("org", undefined, modules).map((i) => i.key);
    expect(keys()).toContain("leads");
    expect(keys()).toContain("companies");
    expect(keys({ leads: false, companies: true })).not.toContain("leads");
    expect(keys({ leads: true, companies: false })).not.toContain("companies");
    // the phone bottom bar keeps four places either way
    const mobile = (modules = DEFAULT_MODULES) => navItems("org", undefined, modules).filter((i) => i.mobile).map((i) => i.key);
    expect(mobile()).toEqual(["home", "leads", "deals", "tasks"]);
    expect(mobile({ leads: false, companies: true })).toEqual(["home", "contacts", "deals", "tasks"]);
  });

  it("the + menu leaves out a switched-off module", () => {
    expect(createItems("org").map((i) => i.key)).toEqual(["lead", "contact", "company", "deal", "task"]);
    expect(createItems("org", undefined, { leads: false, companies: false }).map((i) => i.key)).toEqual(["contact", "deal", "task"]);
  });

  it("with companies off the contact form has no company picker but sends the stored company back", () => {
    const render = (companies: { id: string; name: string }[] | null) =>
      renderToStaticMarkup(createElement(ContactFields, { values: { company_id: "c-1" }, errors: {}, companies, types: [] }));
    const on = render([{ id: "c-1", name: "חברה" }]);
    expect(on).toContain("<select");
    expect(on).toMatch(/name="company_id"/);
    const off = render(null);
    expect(off).not.toMatch(/<select[^>]*name="company_id"/);
    expect(off).toMatch(/<input type="hidden" name="company_id" value="c-1"\/>/);
  });

  it("the leads-only reports are marked, so the index can leave them out", () => {
    expect(REPORTS.filter((r) => r.module === "leads").map((r) => r.key)).toEqual(["sources", "response"]);
  });

  it("a leads import refused while leads are off is explained in Hebrew (part b)", () => {
    expect(dbErrorMessage({ code: "P0001", message: "the leads module is switched off", hint: "module:leads_off" })).toContain("מודול הלידים כבוי");
  });
});
