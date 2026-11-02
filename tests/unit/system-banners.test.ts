import { describe, expect, it } from "vitest";

import { bannerStatus, bannerText, parseAdminBanners, parseOrgIds } from "@/features/platform/banners";
import { parseSystemBanners } from "@/features/system-banners/banners";

const ID = "0b7d3c6e-1f2a-4b5c-8d9e-0a1b2c3d4e5f";
const ID2 = "1b7d3c6e-1f2a-4b5c-8d9e-0a1b2c3d4e5f";

describe("ADM-04: banners a business shows", () => {
  it("keeps only well-formed rows; an info banner can always be closed", () => {
    expect(
      parseSystemBanners([
        { id: ID, body: "שדרוג בלילה", severity: "info", dismissable: false },
        { id: ID2, body: "חשוב", severity: "warning", dismissable: false },
        { id: "x", body: "bad id", severity: "info", dismissable: true },
        { id: ID, body: " ", severity: "info", dismissable: true },
        { id: ID, body: "x", severity: "danger", dismissable: true },
        null,
      ]),
    ).toEqual([
      { id: ID, body: "שדרוג בלילה", severity: "info", dismissable: true },
      { id: ID2, body: "חשוב", severity: "warning", dismissable: false },
    ]);
    expect(parseSystemBanners(null)).toEqual([]);
  });
});

describe("ADM-04: the platform screen", () => {
  it("reads business ids and card addresses, and reports anything else", () => {
    expect(parseOrgIds(`${ID}\n${ID2.toUpperCase()}, ${ID}`)).toEqual({ ids: [ID, ID2], rest: "" });
    expect(parseOrgIds(`https://example.com/admin/orgs/${ID}`)).toEqual({ ids: [ID], rest: "" });
    expect(parseOrgIds(`${ID} עסק של דנה`).rest).not.toBe("");
  });

  it("collapses the text to one line", () => {
    expect(bannerText("  שדרוג \n\n בלילה ")).toBe("שדרוג בלילה");
  });

  it("tells upcoming, live and ended apart", () => {
    const now = new Date("2026-11-02T10:00:00Z");
    expect(bannerStatus({ startsAt: "2026-11-03T00:00:00Z", endsAt: "2026-11-04T00:00:00Z", endedAt: null }, now)).toBe("upcoming");
    expect(bannerStatus({ startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-04T00:00:00Z", endedAt: null }, now)).toBe("live");
    expect(bannerStatus({ startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-04T00:00:00Z", endedAt: "2026-11-02T09:00:00Z" }, now)).toBe("ended");
    expect(bannerStatus({ startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z", endedAt: null }, now)).toBe("ended");
  });

  it("parses the list function's answer", () => {
    const [b] = parseAdminBanners([
      { id: ID, body: "x", severity: "warning", dismissable: false, target_kind: "orgs", target_plan: null, target_orgs: [{ id: ID2, name: "עסק" }], starts_at: "a", ends_at: "b", ended_at: null, dismissals: 3 },
    ]);
    expect(b).toMatchObject({ severity: "warning", target: "orgs", targetOrgs: [{ id: ID2, name: "עסק" }], dismissals: 3, endedAt: null });
  });
});
