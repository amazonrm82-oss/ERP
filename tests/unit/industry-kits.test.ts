import { describe, expect, it } from "vitest";

import {
  ALL_TEMPLATES,
  INDUSTRY_KITS,
  KIT_WORDING_VERSION,
  kitPreviewIsEmpty,
  previewAny,
  suggestedTemplateKey,
  type KitExisting,
} from "@/features/industry-templates/kits";
import { describeApplyResult } from "@/features/industry-templates/schema";
import { INDUSTRY_TEMPLATES, type ExistingLists } from "@/features/industry-templates/templates";
import { messageOffer, messageTemplateProblem } from "@/features/message-templates/service-rule";
import { MESSAGE_MERGE_FIELDS } from "@/features/message-templates/fields";
import { templateVariantProblem } from "@/features/whatsapp/variants";
import { FORM_EXCLUDED_TYPES } from "@/features/intake/fields";
import { readFileSync } from "node:fs";

// VRT-01: industry kits (clinics, studios & courses).

const empty: ExistingLists = { pipelines: [], statuses: [], sources: [], fields: [], automations: [], products: [] };
const noKit: KitExisting = { meetingTypes: [], messageTemplates: [], whatsappTemplates: [], forms: [], leadViews: [], punchCards: false };

// words that would make a field, template or option hold health or medical information (the clinics kit holds none)
const MEDICAL_WORDS = [
  "אבחנה", "אבחון", "תרופה", "תרופות", "מחלה", "מחלות", "רגישות", "אלרגיה", "כאב", "תסמין", "סימפטום", "רפואי", "רפואית",
  "בריאותי", "הצהרת בריאות", "מצב בריאות", "ניתוח", "הריון", "לחץ דם", "סוכרת", "קופת חולים", "מרשם", "רופא", "היסטוריה",
];

const kitTexts = (key: string): string[] => {
  const kit = INDUSTRY_KITS.find((k) => k.template.industry === key)!;
  const t = kit.template;
  return [
    t.title,
    t.pipeline?.name ?? "",
    ...(t.pipeline?.stages.map((s) => s.name) ?? []),
    ...t.statuses,
    ...t.sources,
    ...t.fields.flatMap((f) => [f.label, f.key, ...f.options]),
    ...t.automations.flatMap((a) => [a.name, ...a.actions.map((x) => x.title)]),
    ...kit.products.map((p) => p.name),
    ...kit.meeting_types.map((m) => m.name),
    ...kit.message_templates.flatMap((m) => [m.name, m.subject ?? "", m.body]),
    ...kit.whatsapp_templates.flatMap((w) => [w.name, w.body]),
    kit.form.name,
    kit.form.title,
    kit.form.intro,
    kit.form.success_message,
    ...kit.views.map((v) => v.name),
  ];
};

describe("industry kits: data (VRT-01)", () => {
  it("has the two kits of owner (274), offered before the FLD-05 templates, with keys no sign-up industry uses", () => {
    expect(INDUSTRY_KITS.map((k) => k.template.industry)).toEqual(["clinic", "studio"]);
    expect(ALL_TEMPLATES.slice(0, 2).map((t) => t.industry)).toEqual(["clinic", "studio"]);
    expect(ALL_TEMPLATES).toHaveLength(INDUSTRY_TEMPLATES.length + 2);
    expect(new Set(ALL_TEMPLATES.map((t) => t.industry)).size).toBe(ALL_TEMPLATES.length);
  });

  it("the clinics kit holds no health or medical words", () => {
    for (const text of kitTexts("clinic")) {
      for (const word of MEDICAL_WORDS) expect(text, text).not.toContain(word);
    }
  });

  it("message templates use only known merge fields, pass the service rule, hold no offer, and wording is neutral", () => {
    for (const kit of INDUSTRY_KITS) {
      for (const m of kit.message_templates) {
        for (const token of `${m.subject ?? ""} ${m.body}`.match(/\{[^{}]+\}/g) ?? []) {
          expect(Object.values(MESSAGE_MERGE_FIELDS).map((f) => f.token), `${m.name}: ${token}`).toContain(token);
        }
        expect(messageTemplateProblem({ channel: m.channel, messageType: m.message_type, subject: m.subject, body: m.body }), m.name).toBeNull();
        expect(messageOffer(`${m.subject ?? ""}\n${m.body}`), m.name).toBe(false);
        expect((m.channel === "email") === (m.subject !== null), m.name).toBe(true);
      }
      for (const w of kit.whatsapp_templates) expect(templateVariantProblem(w.body), w.name).toBeNull();
    }
    expect(KIT_WORDING_VERSION).toMatch(/^[a-z0-9-]{1,40}$/);
  });

  it("each kit's form asks a contact way, its custom fields are the kit's own lead fields, and its views name its statuses", () => {
    for (const kit of INDUSTRY_KITS) {
      const leadKeys = kit.template.fields.filter((f) => f.object_type === "lead").map((f) => `cf:${f.key}`);
      for (const f of kit.form.fields) {
        if (f.key.startsWith("cf:")) expect(leadKeys).toContain(f.key);
        else expect(["full_name", "phone", "email", "company_name", "message"]).toContain(f.key);
      }
      expect(kit.form.fields.some((f) => f.key === "phone" && f.required)).toBe(true);
      for (const v of kit.views) expect(kit.template.statuses).toContain(v.status);
      const names = kit.meeting_types.map((m) => m.name);
      const products = kit.products.map((p) => p.name);
      for (const m of kit.meeting_types) if (m.product) expect(products).toContain(m.product);
      for (const p of kit.products) {
        expect(p.kind === "punch_card").toBe(p.punch !== null);
        if (p.punch?.meeting_type) expect(names).toContain(p.punch.meeting_type);
      }
    }
  });
});

describe("industry kits: database rules (VRT-01)", () => {
  const sql = readFileSync("supabase/migrations/20261006021252_industry_kits.sql", "utf8");

  it("the form step leaves out the field types of FORM_EXCLUDED_TYPES, the same list", () => {
    const list = /fd\.field_type not in \(([^)]*)\)/.exec(sql)?.[1];
    expect(list?.split(",").map((t) => t.trim().replace(/'/g, "")).sort()).toEqual([...FORM_EXCLUDED_TYPES].sort());
  });

  it("the kits hold marketing message templates only", () => {
    for (const kit of INDUSTRY_KITS) for (const m of kit.message_templates) expect(m.message_type).toBe("marketing");
  });
});

describe("previewAny (VRT-01)", () => {
  it("previews a kit's extras and its own products; punch cards only with the key", () => {
    const r = previewAny("clinic", empty, noKit)!;
    expect(r.preview.products.map((p) => p.name)).toEqual(["פגישת היכרות", "טיפול"]);
    expect(r.kit!.meetingTypes).toEqual(["תור ראשון", "טיפול", "שיחת התאמה טלפונית"]);
    expect(r.kit!.form).toBe("טופס קביעת תור");
    const withPunch = previewAny("clinic", empty, { ...noKit, punchCards: true })!;
    expect(withPunch.preview.products.map((p) => p.name)).toContain("כרטיסייה ל-10 טיפולים");
    // no product catalog: no products at all
    expect(previewAny("clinic", { ...empty, products: null }, { ...noKit, punchCards: true })!.preview.products).toEqual([]);
  });

  it("leaves out what exists (outer spaces and, where the table folds case, case ignored)", () => {
    const kit = INDUSTRY_KITS[1];
    const r = previewAny("studio", empty, {
      meetingTypes: kit.meeting_types.map((m) => ` ${m.name} `),
      messageTemplates: kit.message_templates.map((m) => m.name),
      whatsappTemplates: kit.whatsapp_templates.map((m) => m.name),
      forms: [kit.form.name],
      leadViews: kit.views.map((v) => v.name),
      punchCards: true,
    })!;
    expect(kitPreviewIsEmpty(r.kit)).toBe(true);
    // a view whose status is neither the business's nor the kit's is not offered (the SQL skips it)
    const kitNoStatus = previewAny("clinic", { ...empty, statuses: [] }, noKit)!;
    expect(kitNoStatus.kit!.views).toEqual(INDUSTRY_KITS[0].views.map((v) => v.name));
    expect(previewAny("services", empty, noKit)!.kit).toBeNull();
    expect(previewAny("nope", empty, noKit)).toBeNull();
  });

  it("suggests the kit of a sign-up industry", () => {
    expect(suggestedTemplateKey("health")).toBe("clinic");
    expect(suggestedTemplateKey("education")).toBe("studio");
    expect(suggestedTemplateKey("retail")).toBe("retail");
    expect(suggestedTemplateKey(null)).toBeNull();
  });

  it("describes a kit's extras and their limits", () => {
    const zero = { pipelines: 0, stages: 0, statuses: 0, sources: 0, fields: 0, automations: 0, products: 0, meeting_types: 0, message_templates: 0, whatsapp_templates: 0, forms: 0, views: 0 };
    expect(describeApplyResult({ added: { ...zero, meeting_types: 3, forms: 1, views: 2 }, limits: ["message_templates:max"] })).toBe(
      "נוספו: 3 סוגי פגישות, טופס לידים (כבוי, מפעילים אותו בהגדרות הטפסים), 2 תצוגות שמורות. לא נוסף: הרשימה מלאה (50) בתבניות ההודעה.",
    );
    // owner (351) ב: "מגבלת החבילה" only for plan keys; a full list of 50 says so
    const both = describeApplyResult({
      added: { ...zero, views: 1 },
      limits: ["limit:max_forms", "meeting_types:max", "whatsapp_templates:max"],
    });
    expect(both).toBe(
      "נוספו: תצוגה שמורה אחת. חלק מהתבנית לא נוסף בגלל מגבלת החבילה: טופס הלידים. לא נוסף: הרשימה מלאה (50) בסוגי הפגישות, בתבניות הוואטסאפ.",
    );
    expect(describeApplyResult({ added: zero, limits: ["message_templates:max"] })).not.toContain("מגבלת החבילה");
  });
});
