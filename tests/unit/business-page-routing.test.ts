import { describe, expect, it } from "vitest";

import { routingColumns } from "@/features/business-page/model";

// BIZ-01 (314) ב: the settings form's choice writes at most one of the two columns (the database checks it again)
describe("business page routing columns", () => {
  const person = "11111111-1111-4111-8111-111111111111";
  const team = "22222222-2222-4222-8222-222222222222";
  it("default clears both, a person sets only the person, a team only the team", () => {
    expect(routingColumns("default", person, team)).toEqual({ owner_user_id: null, team_id: null });
    expect(routingColumns("person", person, team)).toEqual({ owner_user_id: person, team_id: null });
    expect(routingColumns("team", person, team)).toEqual({ owner_user_id: null, team_id: team });
  });
});
