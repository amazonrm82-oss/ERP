import { beforeEach, describe, expect, it, vi } from "vitest";

// RVW-13: personal data functions refuse a session that has not passed the second step.
const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));

const refused = { code: "42501", hint: "mfa:aal2_required", message: "two-step verification required" };

describe("second step required (RVW-13)", () => {
  beforeEach(() => rpc.mockReset());

  it("is recognised by code and hint only, and has its own Hebrew message", async () => {
    const { dbErrorMessage, needsSecondStep, NO_PERMISSION, SECOND_STEP_REQUIRED } = await import("@/lib/errors");
    expect(needsSecondStep(refused)).toBe(true);
    expect(needsSecondStep({ code: "42501", message: "admins only" })).toBe(false);
    expect(needsSecondStep({ code: "P0001", hint: "mfa:aal2_required", message: "x" })).toBe(false);
    expect(needsSecondStep(null)).toBe(false);
    expect(dbErrorMessage(refused)).toBe(SECOND_STEP_REQUIRED);
    expect(dbErrorMessage({ code: "42501", message: "admins only" })).toBe(NO_PERMISSION);
  });

  it("the device list says 'second step' instead of breaking the account page", async () => {
    const { listMySessions } = await import("@/features/account/queries");
    rpc.mockResolvedValueOnce({ data: null, error: refused });
    expect(await listMySessions()).toEqual({ ok: false, reason: "second_step" });
    rpc.mockResolvedValueOnce({
      data: [{ id: "s1", created_at: "2026-10-01T10:00:00Z", last_active_at: "2026-10-02T10:00:00Z", user_agent: "Chrome", ip: "10.0.0.1", is_current: true }],
      error: null,
    });
    const ok = await listMySessions();
    expect(ok).toEqual({ ok: true, sessions: [{ id: "s1", createdAt: "2026-10-01T10:00:00Z", lastActiveAt: "2026-10-02T10:00:00Z", userAgent: "Chrome", ip: "10.0.0.1", isCurrent: true }] });
    rpc.mockResolvedValueOnce({ data: null, error: { code: "57014", message: "timeout" } });
    await expect(listMySessions()).rejects.toThrow(/my_sessions/);
  });

  it("backup code count and the signed agreement do not throw either", async () => {
    const { getRecoveryCodesLeft } = await import("@/features/account/queries");
    const { getMyAgreement } = await import("@/features/legal/queries");
    rpc.mockResolvedValueOnce({ data: null, error: refused });
    expect(await getRecoveryCodesLeft()).toBe(0);
    rpc.mockResolvedValueOnce({ data: null, error: refused });
    expect(await getMyAgreement()).toBe("second_step");
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await getMyAgreement()).toBeNull();
    rpc.mockResolvedValueOnce({ data: null, error: { code: "57014", message: "timeout" } });
    await expect(getRecoveryCodesLeft()).rejects.toThrow(/mfa_recovery_codes_status/);
  });
});
