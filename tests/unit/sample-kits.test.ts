import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SAMPLE_KIT_CONTENT, sampleDataBlurb, sampleDataKit, sampleKitContent } from "@/features/setup/sample-kits";

// VRT-03: sample data by industry. tests/db/358-sample-data-kits compares the content with the database's copy.

// the closed list of tests/db/356-industry-kits and tests/unit/industry-kits
const MEDICAL_WORDS = [
  "אבחנה", "אבחון", "תרופה", "תרופות", "מחלה", "מחלות", "רגישות", "אלרגיה", "כאב", "תסמין", "סימפטום", "רפואי", "רפואית",
  "בריאותי", "הצהרת בריאות", "מצב בריאות", "ניתוח", "הריון", "לחץ דם", "סוכרת", "קופת חולים", "מרשם", "רופא", "היסטוריה",
  "diagnos", "medic", "allerg", "health",
];

const migration = () => {
  const dir = path.resolve(__dirname, "../../supabase/migrations");
  const file = readdirSync(dir).find((f) => f.endsWith("_sample_data_kits.sql"))!;
  return readFileSync(path.join(dir, file), "utf8");
};

describe("sample data by industry (VRT-03)", () => {
  it("every text of every set is free of health or medical words", () => {
    for (const content of SAMPLE_KIT_CONTENT) {
      const text = JSON.stringify(content).toLowerCase();
      for (const word of MEDICAL_WORDS) expect(text, `${content.kit}: ${word}`).not.toContain(word.toLowerCase());
      expect(sampleDataBlurb(content.kit).toLowerCase()).not.toMatch(new RegExp(MEDICAL_WORDS.join("|")));
    }
  });

  it("uses invented addresses only, no phones, and the set's shape the database expects", () => {
    for (const content of SAMPLE_KIT_CONTENT) {
      for (const p of [...content.leads, ...content.contacts]) expect(p.email).toMatch(/^[a-z]+@example\.com$/);
      expect(JSON.stringify(content)).not.toMatch(/phone|05\d/);
      const keys = new Set([...content.leads.map((l) => l.key), ...content.contacts.map((c) => c.key)]);
      expect(keys.size).toBe(content.leads.length + content.contacts.length);
      expect(content.contacts.map((c) => c.key)).toContain(content.deal.contact);
      if (content.punch_card) expect(content.contacts.map((c) => c.key)).toContain(content.punch_card.contact);
      for (const t of content.tasks) {
        if (t.lead) expect(content.leads.map((l) => l.key)).toContain(t.lead);
        expect(Number.isInteger(t.due_minutes) && t.due_minutes > 0).toBe(true);
      }
    }
  });

  it("the migration holds the same content (one JSON literal per kit)", () => {
    const sql = migration();
    for (const { kit, ...rest } of SAMPLE_KIT_CONTENT) {
      expect(sql).toContain(`when '${kit}' then $c$${JSON.stringify(rest)}$c$::jsonb`);
    }
  });

  it("the kit is the last kit applied, else the sign-up industry's, else none", () => {
    expect(sampleDataKit({ industry: null, industry_templates: [] })).toBeNull();
    expect(sampleDataKit({ industry: "services", industry_templates: ["services"] })).toBeNull();
    expect(sampleDataKit({ industry: "health", industry_templates: [] })).toBe("clinic");
    expect(sampleDataKit({ industry: "education", industry_templates: [] })).toBe("studio");
    expect(sampleDataKit({ industry: "health", industry_templates: ["clinic", "studio"] })).toBe("studio");
    expect(sampleDataKit({ industry: "services", industry_templates: ["clinic", "services"] })).toBe("clinic");
    expect(sampleKitContent("services")).toBeNull();
  });

  it("describes the set in the industry's words; the generic line is unchanged", () => {
    expect(sampleDataBlurb(null)).toBe("רוצים לראות איך זה נראה? אפשר להוסיף כמה לידים, אנשי קשר ועסקה לדוגמה, ולמחוק אותם בלחיצה.");
    expect(sampleDataBlurb("clinic")).toContain("2 מטופלים (יעל ברגר ומשה פרידמן)");
    expect(sampleDataBlurb("studio")).toContain("2 תלמידים");
  });
});
