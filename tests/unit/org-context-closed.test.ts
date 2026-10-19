import { beforeEach, describe, expect, it, vi } from "vitest";

import { AGREEMENT_VERSION } from "@/features/legal/agreement";

// RVW-30 (b): BIL-09 in the app. In a business closed until payment the database gives no role but the
// owner's, and public.closed_orgs() names the caller's role there. getOrgContextForOwner lets only the
// owner through (plan screen, full export); getOrgContext sends everyone to the one screen;
// getOrgContextAllowClosed answers as it is.

class Redirect extends Error {
  constructor(public to: string) {
    super(`redirect ${to}`);
  }
}

let closedRole: string | null = "owner";
let openOrg = false;

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "u1", email: "dana@example.test", fullName: "דנה" }) }));

const ORG = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string) => {
      if (name === "org_context") {
        return {
          data: openOrg
            ? {
                org: { id: ORG, name: "עסק", status: "active", timezone: "Asia/Jerusalem", currency: "ILS" },
                membership: { role: "member", is_available: true },
                subscription: null,
                full_name: "דנה",
                agreement_version: AGREEMENT_VERSION,
              }
            : { org: null, membership: null, subscription: null, full_name: "דנה", agreement_version: AGREEMENT_VERSION },
          error: null,
        };
      }
      if (name === "mfa_required_orgs") return { data: [], error: null };
      if (name === "closed_orgs") {
        return { data: closedRole ? [{ id: ORG, name: "עסק סגור", status: "suspended", role: closedRole }] : [], error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

async function load() {
  return import("@/features/shell/queries");
}

describe("a business closed until payment, in the app (RVW-30, BIL-09)", () => {
  beforeEach(() => {
    vi.resetModules();
    closedRole = "owner";
    openOrg = false;
  });

  it("its owner gets the context for the plan screen and the full export", async () => {
    const { getOrgContextForOwner, getOrgContextAllowClosed } = await load();
    const context = await getOrgContextForOwner(ORG);
    expect(context).toMatchObject({ role: "owner", closed: true, canWrite: false, canDelete: false, org: { id: ORG, status: "suspended" } });
    expect(await getOrgContextAllowClosed(ORG)).toMatchObject({ role: "owner", closed: true });
  });

  it("every other role goes to the one closed screen", async () => {
    for (const role of ["admin", "manager", "member", "viewer"]) {
      closedRole = role;
      vi.resetModules();
      const { getOrgContextForOwner, getOrgContextAllowClosed } = await load();
      await expect(getOrgContextForOwner(ORG), role).rejects.toMatchObject({ to: `/o/${ORG}/suspended` });
      // the frame and the closed screen itself still read it
      expect(await getOrgContextAllowClosed(ORG)).toMatchObject({ role, closed: true });
    }
  });

  it("getOrgContext sends even the owner to the closed screen", async () => {
    const { getOrgContext } = await load();
    await expect(getOrgContext(ORG)).rejects.toMatchObject({ to: `/o/${ORG}/suspended` });
  });

  it("an open business is not affected: a member gets the context", async () => {
    openOrg = true;
    closedRole = null;
    const { getOrgContextForOwner } = await load();
    expect(await getOrgContextForOwner(ORG)).toMatchObject({ role: "member", closed: false, canWrite: true });
  });

  it("not a member of a closed business: not found", async () => {
    closedRole = null;
    const { getOrgContextForOwner } = await load();
    await expect(getOrgContextForOwner(ORG)).rejects.toThrow("not found");
  });
});
