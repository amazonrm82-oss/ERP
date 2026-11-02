// ADM-05: support requests on the platform screen. Pure, so the parsing is unit-tested.

export type AdminSupportRequest = {
  id: string;
  orgId: string;
  orgName: string;
  requesterName: string | null;
  requesterEmail: string | null;
  category: string;
  subject: string;
  message: string;
  pagePath: string | null;
  status: string;
  createdAt: string;
  statusChangedAt: string | null;
  notes: { id: string; body: string; authorName: string | null; createdAt: string }[];
};

export type AdminSupportList = {
  total: number;
  counts: { open: number; in_progress: number; closed: number };
  rows: AdminSupportRequest[];
};

export const SUPPORT_LIST_PAGE = 100;

const str = (value: unknown) => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => Number(value) || 0;
const obj = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function parseAdminSupportList(data: unknown): AdminSupportList {
  const root = obj(data);
  const counts = obj(root.counts);
  const rows = Array.isArray(root.rows) ? root.rows.map(obj) : [];
  return {
    total: num(root.total),
    counts: { open: num(counts.open), in_progress: num(counts.in_progress), closed: num(counts.closed) },
    rows: rows.map((row) => ({
      id: str(row.id),
      orgId: str(row.organization_id),
      orgName: str(row.organization_name),
      requesterName: strOrNull(row.requester_name),
      requesterEmail: strOrNull(row.requester_email),
      category: str(row.category),
      subject: str(row.subject),
      message: str(row.message),
      pagePath: strOrNull(row.page_path),
      status: str(row.status),
      createdAt: str(row.created_at),
      statusChangedAt: strOrNull(row.status_changed_at),
      notes: (Array.isArray(row.notes) ? row.notes.map(obj) : []).map((note) => ({
        id: str(note.id),
        body: str(note.body),
        authorName: strOrNull(note.author_name),
        createdAt: str(note.created_at),
      })),
    })),
  };
}

/** The status filter from the address; anything else = every status. */
export function supportStatusFilter(value: string | string[] | undefined): "open" | "in_progress" | "closed" | null {
  return value === "open" || value === "in_progress" || value === "closed" ? value : null;
}
