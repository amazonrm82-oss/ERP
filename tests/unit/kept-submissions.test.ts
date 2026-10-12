import { beforeEach, describe, expect, it, vi } from "vitest";

// CAP-04 (owner, 12 October 2026): an inquiry whose form was deleted before CAP-04 has no
// stored form name; the log shows "טופס שנמחק" for it, never an empty field.

type Row = { id: string; status: string; lead_id: string | null; payload: unknown; created_at: string; form_name: string | null };

const state: { rows: Row[]; calls: Array<[string, ...unknown[]]> } = { rows: [], calls: [] };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const chain = {
      select: (...args: unknown[]) => (state.calls.push(["select", ...args]), chain),
      eq: (...args: unknown[]) => (state.calls.push(["eq", ...args]), chain),
      is: (...args: unknown[]) => (state.calls.push(["is", ...args]), chain),
      order: (...args: unknown[]) => (state.calls.push(["order", ...args]), chain),
      limit: async (...args: unknown[]) => {
        state.calls.push(["limit", ...args]);
        return { data: state.rows, error: null };
      },
    };
    return { from: (table: string) => (state.calls.push(["from", table]), chain) };
  },
}));

const { listKeptSubmissions } = await import("@/features/intake/queries");

function row(id: string, formName: string | null): Row {
  return { id, status: "accepted", lead_id: null, payload: { full_name: "דנה" }, created_at: "2026-10-01T10:00:00Z", form_name: formName };
}

describe("kept submissions of a deleted form", () => {
  beforeEach(() => {
    state.rows = [];
    state.calls = [];
  });

  it("reads only submissions whose form is gone", async () => {
    await listKeptSubmissions("org-1");
    expect(state.calls).toContainEqual(["from", "form_submissions"]);
    expect(state.calls).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(state.calls).toContainEqual(["is", "form_id", null]);
  });

  it("falls back to 'טופס שנמחק' when no name was stored", async () => {
    state.rows = [row("a", null), row("b", ""), row("c", "   ")];
    const items = await listKeptSubmissions("org-1");
    expect(items.map((item) => item.formName)).toEqual(["טופס שנמחק", "טופס שנמחק", "טופס שנמחק"]);
  });

  it("keeps the stored name, trimmed", async () => {
    state.rows = [row("a", "  טופס אתר  ")];
    const [item] = await listKeptSubmissions("org-1");
    expect(item.formName).toBe("טופס אתר");
    expect(item.summary).toBe("דנה");
  });
});
