import { describe, expect, it } from "vitest";

import { notificationHref } from "@/features/notifications/links";
import { pushPayload } from "@/features/notifications/push-payload";

// Owner, 13 October 2026 (migration 0163): a new lead in a suspended business tells its owner a count only,
// and a tap leads to the plan page.
describe("new-lead notice of a suspended business", () => {
  const org = "11111111-1111-4111-8111-111111111111";

  it("links to the plan page", () => {
    expect(notificationHref(org, "subscription", org)).toBe(`/o/${org}/settings/plan`);
  });

  it("pushes the title and the business name only, to the plan page, with no lead actions", () => {
    const title = "נכנס ליד חדש לעסק לדוגמה. כדי לראות אותו, חדשו את המנוי.";
    const payload = pushPayload({
      id: "22222222-2222-4222-8222-222222222222",
      organization_id: org,
      user_id: "33333333-3333-4333-8333-333333333333",
      title,
      body: null,
      entity_type: "subscription",
      entity_id: org,
      organization_name: "עסק לדוגמה",
      type: "system",
      lead_actions: false,
    });
    expect(payload).toEqual({ title, body: "עסק לדוגמה", url: `/o/${org}/settings/plan`, tag: "22222222-2222-4222-8222-222222222222" });
  });
});
