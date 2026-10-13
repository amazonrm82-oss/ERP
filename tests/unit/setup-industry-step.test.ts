import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { INDUSTRY_TEMPLATES, previewTemplate } from "@/features/industry-templates/templates";

vi.mock("@/features/setup/actions", () => ({ saveSetupIndustryAction: async () => null }));

const { IndustryStepForm } = await import("@/features/setup/components/industry-step-form");

const previews = Object.fromEntries(
  INDUSTRY_TEMPLATES.map((t) => [t.industry, previewTemplate(t, { pipelines: [], statuses: [], sources: [], fields: [], automations: [] })]),
);

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);

// FLD-05: Enter in setup step 2 never applies the template, and the visible
// buttons keep the same order on screen and for focus (WCAG 2.4.3).
describe("setup step 2 buttons (FLD-05)", () => {
  it("the form's default button does not apply, and keyboard and screen readers never reach it", () => {
    const html = renderToStaticMarkup(createElement(IndustryStepForm, { orgId: "o1", industry: "real_estate", previews }));
    const all = buttons(html);
    expect(all).toHaveLength(3);
    const [first, apply, skip] = all;
    expect(first).toMatch(/type="submit"/);
    expect(first).toMatch(/name="apply"/);
    expect(first).toMatch(/value="0"/);
    expect(first).toMatch(/tabindex="-1"/i);
    expect(first).toMatch(/aria-hidden="true"/);
    // visible: apply first, then continue without; no reordering by CSS
    expect(apply).toMatch(/value="1"/);
    expect(skip).toMatch(/value="0"/);
    for (const b of [apply, skip]) {
      expect(b).not.toMatch(/[\s"]order-/);
      expect(b).not.toMatch(/tabindex/i);
    }
  });

  it("without a template there is no apply button", () => {
    const html = renderToStaticMarkup(createElement(IndustryStepForm, { orgId: "o1", industry: null, previews }));
    expect(buttons(html).some((b) => /value="1"/.test(b))).toBe(false);
  });
});
