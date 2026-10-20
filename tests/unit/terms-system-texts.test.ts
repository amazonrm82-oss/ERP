import { describe, expect, it } from "vitest";

import { conversionText, responsePassText, stageChangeText } from "@/features/activities/system-entries";
import { createDealAction, DEFAULT_DEAL_NAME, defaultDealName, describeCreateDeal } from "@/features/automations/create-records";
import { pushPayload, type ClaimedNotification } from "@/features/notifications/push-payload";
import { DEFAULT_TERMS, resolveTerms } from "@/features/terminology/terms";

const MASCULINE = resolveTerms({ contact: "customer", lead: "prospect", deal: "case" });
const FEMININE = resolveTerms({ contact: "patient", lead: "inquiry", deal: "opportunity" });

describe("timeline entries the app draws (FLD-10 part three)", () => {
  const names = new Map([
    ["u1", "דנה"],
    ["u2", "יוסי"],
  ]);

  it("SPD-03's pass-on, from its metadata, in both genders; today's words read as the database wrote them", () => {
    const meta = { fromUserId: "u1", toUserId: "u2", targetMinutes: 60 };
    expect(responsePassText(meta, names, DEFAULT_TERMS)).toBe("הליד הועבר מדנה ליוסי כי לא נוצר קשר בתוך 60 דקות");
    expect(responsePassText(meta, names, MASCULINE)).toBe("המתעניין הועבר מדנה ליוסי כי לא נוצר קשר בתוך 60 דקות");
    expect(responsePassText(meta, names, FEMININE)).toBe("הפנייה הועברה מדנה ליוסי כי לא נוצר קשר בתוך 60 דקות");
    // a rep without a name is left out, as the database left them out
    expect(responsePassText({ fromUserId: null, toUserId: "u3", targetMinutes: 30 }, names, FEMININE)).toBe("הפנייה הועברה כי לא נוצר קשר בתוך 30 דקות");
    // no usable target: the stored text stays
    expect(responsePassText({ fromUserId: "u1", toUserId: "u2", targetMinutes: null }, names, FEMININE)).toBeNull();
    expect(responsePassText({ fromUserId: "u1", toUserId: "u2", targetMinutes: 1.5 }, names, FEMININE)).toBeNull();
  });

  it("a conversion and a stage move", () => {
    expect(conversionText(DEFAULT_TERMS)).toBe("הליד הומר לאיש קשר.");
    expect(conversionText(MASCULINE)).toBe("המתעניין הומר ללקוח.");
    expect(conversionText(FEMININE)).toBe("הפנייה הומרה למטופל.");
    expect(stageChangeText("הצעה", "משא ומתן", DEFAULT_TERMS)).toBe('העסקה עברה מהשלב "הצעה" לשלב "משא ומתן".');
    expect(stageChangeText("הצעה", "משא ומתן", MASCULINE)).toBe('התיק עבר מהשלב "הצעה" לשלב "משא ומתן".');
    expect(stageChangeText(undefined, "משא ומתן", FEMININE)).toBe("ההזדמנות עברה שלב.");
    expect(stageChangeText(undefined, undefined, DEFAULT_TERMS)).toBe("העסקה עברה שלב.");
  });
});

describe("a push in the business's words", () => {
  const note = (extra: Partial<ClaimedNotification> = {}): ClaimedNotification => ({
    id: "33333333-3333-4333-8333-333333333333",
    organization_id: "11111111-1111-4111-8111-111111111111",
    user_id: "44444444-4444-4444-8444-444444444444",
    title: "ליד חדש מחכה למי שייקח אותו",
    body: null,
    entity_type: "lead",
    entity_id: "22222222-2222-4222-8222-222222222222",
    organization_name: "עסק",
    type: "lead_new",
    ...extra,
  });

  it("uses the term keys the claim returns; none, an empty row or an unknown key = today's words", () => {
    expect(pushPayload(note({ terms: { lead_term: "inquiry", contact_term: null, deal_term: null } })).title).toBe("פנייה חדשה מחכה למי שייקח אותה");
    expect(pushPayload(note()).title).toBe("ליד חדש מחכה למי שייקח אותו");
    expect(pushPayload(note({ terms: { lead_term: null, contact_term: null, deal_term: null } })).title).toBe("ליד חדש מחכה למי שייקח אותו");
    expect(pushPayload(note({ terms: { lead_term: "nonsense" } })).title).toBe("ליד חדש מחכה למי שייקח אותו");
    // the body too, after the business's name
    const reminder = pushPayload(note({ title: "תזכורת: להתקשר", body: "הליד עוד לא אצל אף אחד", terms: { lead_term: "prospect" } }));
    expect(reminder).toMatchObject({ title: "תזכורת: להתקשר", body: "עסק: המתעניין עוד לא אצל אף אחד" });
  });
});

describe("the default name of a deal a rule makes", () => {
  const lookups = {
    pipelines: [{ id: "p1", name: "מכירות", stages: [{ id: "s1", name: "חדש", kind: "open" }] }],
    members: [],
  };

  it("today's word stores nothing (the database's default); the business's own word is stored", () => {
    expect(DEFAULT_DEAL_NAME).toBe("עסקה: {{name}}");
    expect(defaultDealName("תיק")).toBe("תיק: {{name}}");
    expect(createDealAction("contact", { pipeline_id: "p1", assign: "owner" }, lookups)).toEqual({ type: "create_deal", pipeline_id: "p1", assign: "owner" });
    expect(createDealAction("contact", { pipeline_id: "p1", assign: "owner" }, { ...lookups, dealWord: "עסקה" })).toEqual({
      type: "create_deal",
      pipeline_id: "p1",
      assign: "owner",
    });
    expect(createDealAction("contact", { pipeline_id: "p1", assign: "owner" }, { ...lookups, dealWord: "הזדמנות" })).toEqual({
      type: "create_deal",
      pipeline_id: "p1",
      assign: "owner",
      name: "הזדמנות: {{name}}",
    });
    // a name the person typed always wins
    expect(createDealAction("contact", { pipeline_id: "p1", assign: "owner", name: "חידוש" }, { ...lookups, dealWord: "תיק" })).toMatchObject({ name: "חידוש" });
    // a stored rule without a name says what the database makes
    expect(describeCreateDeal({ pipeline_id: "p1", assign: "owner" }, lookups)).toContain('"עסקה: {{name}}"');
  });
});
