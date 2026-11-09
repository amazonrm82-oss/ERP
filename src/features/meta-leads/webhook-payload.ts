/**
 * CAP-11: what the Meta webhook carries, read after the signature passed. Only the ids are kept: page id, lead id
 * (leadgen_id) and form id; the lead's details are fetched from the Graph API later (owner (126) א). Anything else in the
 * body is ignored. At most MAX_LEADS per request, and at most that many per page (the database's own cap).
 */

export const MAX_LEADS = 100;

export type PageLeads = { pageId: string; leads: { id: string; form_id: string | null }[] };

const ID = /^[0-9]{1,40}$/;

const idOf = (value: unknown): string | null => {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : null;
  return text !== null && ID.test(text) ? text : null;
};

/** The page groups of a parsed body, or null when it is not a page webhook or holds more than MAX_LEADS leads. */
export function leadgenWebhook(body: unknown): PageLeads[] | null {
  if (typeof body !== "object" || body === null) return null;
  const root = body as { object?: unknown; entry?: unknown };
  if (root.object !== "page" || !Array.isArray(root.entry)) return null;
  const pages = new Map<string, Map<string, string | null>>();
  let total = 0;
  for (const entry of root.entry) {
    if (typeof entry !== "object" || entry === null) continue;
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (typeof change !== "object" || change === null) continue;
      const { field, value } = change as { field?: unknown; value?: unknown };
      if (field !== "leadgen" || typeof value !== "object" || value === null) continue;
      const v = value as { leadgen_id?: unknown; page_id?: unknown; form_id?: unknown };
      const pageId = idOf(v.page_id) ?? idOf((entry as { id?: unknown }).id);
      const leadId = idOf(v.leadgen_id);
      if (!pageId || !leadId) continue;
      const leads = pages.get(pageId) ?? new Map<string, string | null>();
      if (!leads.has(leadId)) {
        total += 1;
        if (total > MAX_LEADS) return null;
        leads.set(leadId, idOf(v.form_id));
      }
      pages.set(pageId, leads);
    }
  }
  return [...pages.entries()].map(([pageId, leads]) => ({
    pageId,
    leads: [...leads.entries()].map(([id, form_id]) => ({ id, form_id })),
  }));
}
