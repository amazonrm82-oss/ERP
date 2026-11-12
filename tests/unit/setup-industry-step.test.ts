import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ALL_TEMPLATES, previewAny } from "@/features/industry-templates/kits";

vi.mock("@/features/setup/actions", () => ({ saveSetupIndustryAction: async () => null }));

const { IndustryStepForm } = await import("@/features/setup/components/industry-step-form");

const previews = Object.fromEntries(
  ALL_TEMPLATES.map((t) => [
    t.industry,
    previewAny(
      t.industry,
      { pipelines: [], statuses: [], sources: [], fields: [], automations: [], products: null },
      { meetingTypes: [], messageTemplates: [], whatsappTemplates: [], forms: [], leadViews: [], punchCards: false },
    )!,
  ]),
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

// VRT-01, owner (349) א: a health or education business gets the new kit as the default, and the old
// FLD-05 template stays offered in the same select.
describe("setup step 2 kit choice (VRT-01)", () => {
  it.each([
    ["health", "clinic"],
    ["education", "studio"],
  ])("industry %s: the kit %s is selected and the old template is offered too", (industry, kit) => {
    const html = renderToStaticMarkup(createElement(IndustryStepForm, { orgId: "o1", industry, previews }));
    const select = /<select[^>]*name="template"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
    expect(select).toMatch(new RegExp(`<option value="${kit}" selected=""`));
    expect(select).toContain(`<option value="${industry}"`);
  });
});
