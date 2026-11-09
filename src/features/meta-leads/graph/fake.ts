import type { GraphLead, MetaGraphProvider } from "./types";

/**
 * CAP-11: the fake Graph provider. No network: it answers from the ids it is given, so local runs and tests can follow
 * a lead end to end. It keeps the contract of types.ts: a token belongs to one page, written `fake-<page id>-<anything>`
 * (the stand-in for `/me?fields=id`), so checkPage and fetchLead refuse a token of another page ("token_invalid"). A lead id
 * ending in 404 is gone at Meta, in 503 Meta does not answer, in 777 Meta limits us. Never allowed on a Vercel production
 * or preview deployment (select.ts).
 */
/** The page a fake token belongs to (`fake-<page id>-...`), or null. */
export function fakeTokenPage(token: string): string | null {
  return /^fake-([0-9]{1,40})-/.exec(token)?.[1] ?? null;
}

export function createFakeGraphProvider(): MetaGraphProvider {
  return {
    code: "fake",
    async checkPage(pageId, pageToken) {
      if (!/^[0-9]{1,40}$/.test(pageId)) return { ok: false, code: "not_found" };
      return fakeTokenPage(pageToken) === pageId ? { ok: true } : { ok: false, code: "token_invalid" };
    },
    async fetchLead(leadId, pageToken, pageId) {
      if (fakeTokenPage(pageToken) !== pageId) return { ok: false, code: "token_invalid" };
      if (leadId.endsWith("404")) return { ok: false, code: "not_found" };
      if (leadId.endsWith("503")) return { ok: false, code: "graph_unavailable" };
      if (leadId.endsWith("777")) return { ok: false, code: "rate_limited" };
      const tail = leadId.slice(-7).padStart(7, "0");
      const lead: GraphLead = {
        field_data: [
          { name: "full_name", values: [`ליד לדוגמה ${tail.slice(-4)}`] },
          { name: "email", values: [`lead${tail}@example.test`] },
          { name: "phone_number", values: [`+97250${tail}`] },
          { name: "מה מעניין אותך?", values: ["הצעת מחיר"] },
        ],
        platform: Number(leadId.slice(-1)) % 2 === 1 ? "ig" : "fb",
        campaign_name: "קמפיין לדוגמה",
      };
      return { ok: true, lead };
    },
  };
}
