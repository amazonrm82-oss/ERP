import { beforeEach, describe, expect, it, vi } from "vitest";

// BIZ-01 review: the contact form's route answers a refusal of intake_submit (P0001, e.g. org:read_only) with the neutral
// "not available" answer, never a 500; the other answers keep their meaning.

let reply: { data: unknown; error: unknown } = { data: { status: "accepted" }, error: null };
const calls: string[] = [];
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    rpc: async (name: string) => {
      calls.push(name);
      return reply;
    },
  }),
}));
vi.mock("@/lib/log-server", () => ({ serverLog: async () => undefined }));

const TOKEN = "0123456789abcdef0123456789abcdef";
const post = async (body: unknown) => {
  const { handleBusinessPageSubmit } = await import("@/features/business-page/public-server");
  return handleBusinessPageSubmit(new Request(`https://example.test/api/forms/biz/${TOKEN}`, { method: "POST", body: JSON.stringify(body) }), TOKEN);
};
const person = { full_name: "לקוחה", phone: "050-1234567" };

describe("business page submit route (BIZ-01)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("an intake_submit refusal is the neutral answer, not a 500", async () => {
    reply = { data: null, error: { code: "P0001", hint: "org:read_only", message: "the organization is read-only" } };
    const res = await post(person);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, message: "הדף אינו זמין כרגע." });
    expect(calls).toEqual(["business_page_submit"]);
  });

  it("a rate limit, a missing page and a success keep their answers", async () => {
    reply = { data: null, error: { code: "P0001", hint: "rate_limited", message: "too many submissions" } };
    expect((await post(person)).status).toBe(429);
    reply = { data: null, error: { code: "P0002", message: "business page not found" } };
    expect((await post(person)).status).toBe(404);
    reply = { data: { status: "accepted" }, error: null };
    const res = await post(person);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // without a name and a way to answer, the database is never asked
    calls.length = 0;
    expect((await post({ full_name: "x" })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
