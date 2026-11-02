import { describe, expect, it } from "vitest";

import { notificationHref } from "@/features/notifications/links";
import { parseAdminSupportList, supportStatusFilter } from "@/features/platform/support-requests";

describe("ADM-05: support requests on the platform screen", () => {
  it("parses the list function's answer", () => {
    const list = parseAdminSupportList({
      total: 3,
      counts: { open: 1, in_progress: 1, closed: 1 },
      rows: [
        {
          id: "r1",
          organization_id: "o1",
          organization_name: "עסק",
          requester_name: null,
          requester_email: "a@example.test",
          category: "bug",
          subject: "לא נשמר",
          message: "טקסט",
          page_path: "/o/o1/leads",
          status: "open",
          created_at: "2026-11-02T10:00:00Z",
          status_changed_at: null,
          notes: [{ id: "n1", body: "בדקנו", author_name: "צוות", created_at: "2026-11-02T11:00:00Z" }],
        },
      ],
    });
    expect(list.total).toBe(3);
    expect(list.counts).toEqual({ open: 1, in_progress: 1, closed: 1 });
    expect(list.rows[0]).toMatchObject({ orgId: "o1", orgName: "עסק", requesterName: null, pagePath: "/o/o1/leads", notes: [{ body: "בדקנו" }] });
    expect(parseAdminSupportList(null)).toEqual({ total: 0, counts: { open: 0, in_progress: 0, closed: 0 }, rows: [] });
  });

  it("filters only by a known status", () => {
    expect(supportStatusFilter("closed")).toBe("closed");
    expect(supportStatusFilter("all")).toBeNull();
    expect(supportStatusFilter(["open"])).toBeNull();
  });

  it("the requester's notice opens the support page", () => {
    expect(notificationHref("org-1", "support_request", "r1")).toBe("/o/org-1/support");
  });
});
