import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const myDay = read("src/app/o/[orgId]/page.tsx");

describe("MNY-06 (312) ב: the monthly summary card on My day", () => {
  it("reads this month, for owners and admins only, through the same never-throwing query as the reports page", () => {
    expect(myDay).toContain('import { getMonthlySummary } from "@/features/monthly-summary/queries";');
    expect(myDay).toContain("isAdminRole(role) ? getMonthlySummary(orgId, null) : Promise.resolve(null)");
  });

  it("reuses the reports page's card, and a failed read shows one line instead", () => {
    expect(myDay).toContain('import { MonthlySummaryCard } from "@/features/monthly-summary/components/monthly-summary-card";');
    expect(myDay).toMatch(/monthSummary\?\.ok && monthSummary\.value \? \(\s*<MonthlySummaryCard data=\{monthSummary\.value\}/);
    expect(myDay).toContain("{monthSummary && !monthSummary.ok ? <p");
    expect(myDay).toContain("{monthSummary.message}</p>");
  });

  it("the card's month links lead to the reports page, where earlier months are shown", () => {
    expect(myDay).toContain("basePath={paths.reports(orgId)}");
  });

  it("the query catches every failure (so My day never breaks over it)", () => {
    const query = read("src/features/monthly-summary/queries.ts");
    expect(query).toContain("} catch {");
    expect(query).not.toMatch(/\bthrow\b/);
  });
});
