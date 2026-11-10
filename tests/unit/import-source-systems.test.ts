import { describe, expect, it } from "vitest";

import { IMPORT_TARGETS, suggestMapping, type ImportEntityKey } from "@/features/imports/fields";
import { OPENING_KEYS } from "@/features/imports/opening-balance";
import { normalizeHeader, presetFor, presetMapping, presetMarkText, SOURCE_SYSTEMS } from "@/features/imports/source-systems";

// CHN-05: ready mappings for other systems' export files.

const ENTITIES = ["lead", "contact", "company", "deal"] as const;

describe("CHN-05 header normalization", () => {
  it("folds case, spaces, BOM and the punctuation exports differ in", () => {
    expect(normalizeHeader("﻿  E-mail 1 - Value ")).toBe("e mail 1 value");
    expect(normalizeHeader("Country/Region")).toBe("country region");
    expect(normalizeHeader("Probability (%)")).toBe("probability");
    expect(normalizeHeader("Person - Phone - Work")).toBe(normalizeHeader("person phone  work"));
    expect(normalizeHeader("First_Name")).toBe("first name");
  });
});

describe("CHN-05 presets", () => {
  it("every preset names only targets the wizard knows, each target once per object", () => {
    for (const system of SOURCE_SYSTEMS) {
      for (const entity of ENTITIES) {
        const preset = presetFor(system.key, entity);
        if (!preset) continue;
        const keys = new Set(IMPORT_TARGETS[entity].map((t) => t.key));
        const seen = new Set<string>();
        for (const [to] of preset) {
          if (to === "skip") continue;
          expect(keys.has(to), `${system.key} ${entity} ${to}`).toBe(true);
          expect(seen.has(to), `${system.key} ${entity} ${to} twice`).toBe(false);
          seen.add(to);
        }
      }
    }
  });

  it("no header is named twice in one object's preset", () => {
    for (const system of SOURCE_SYSTEMS) {
      for (const entity of ENTITIES) {
        const names = (presetFor(system.key, entity) ?? []).flatMap(([, headers]) => headers.map(normalizeHeader));
        expect(new Set(names).size, `${system.key} ${entity}`).toBe(names.length);
      }
    }
  });

  it("each preset maps every header it names, in a file that holds all of them", () => {
    for (const system of SOURCE_SYSTEMS) {
      for (const entity of ENTITIES) {
        const preset = presetFor(system.key, entity);
        if (!preset) continue;
        // one header per entry: the first of each, so every entry is reached
        const headers = preset.map(([, names]) => names[0]);
        const { mapping, marks } = presetMapping(headers, system.key, entity, IMPORT_TARGETS[entity]);
        preset.forEach(([to], i) => {
          if (to === "skip") {
            expect(mapping[i], `${system.key} ${entity} ${headers[i]}`).toBe("");
            expect(marks[i]).toBe(to);
          } else {
            expect(mapping[i], `${system.key} ${entity} ${headers[i]}`).toBe(to);
            expect(marks[i]).toBe("preset");
          }
        });
      }
    }
  });

  it("maps the known headers of real export layouts", () => {
    const google = ["First Name", "Middle Name", "Last Name", "Organization Name", "Organization Title", "Birthday", "Notes", "E-mail 1 - Label", "E-mail 1 - Value", "Phone 1 - Label", "Phone 1 - Value"];
    expect(presetMapping(google, "google_contacts", "contact", IMPORT_TARGETS.contact).mapping).toEqual([
      "first_name", "", "last_name", "company", "job_title", "birth_date", "import_note", "", "email", "", "phone",
    ]);
    const outlook = ["Title", "First Name", "Last Name", "Company", "Job Title", "Business Phone", "Mobile Phone", "E-mail Address"];
    expect(presetMapping(outlook, "outlook", "lead", IMPORT_TARGETS.lead).mapping).toEqual(["", "first_name", "last_name", "company_name", "job_title", "", "phone", "email"]);
    const hubspotDeals = ["Record ID", "Deal Name", "Deal Stage", "Close Date", "Deal owner", "Amount", "Pipeline", "Create Date"];
    const hub = presetMapping(hubspotDeals, "hubspot", "deal", IMPORT_TARGETS.deal);
    // CHN-05 (245) ג: owner, pipeline and stage are mapped; missing names are shown before the import runs
    expect(hub.mapping).toEqual(["", "name", "stage", "expected_close_date", "owner", "amount", "pipeline", "original_created_on"]);
    expect(hub.marks).toEqual(["skip", "preset", "preset", "preset", "preset", "preset", "preset", "preset"]);
    const salesforce = ["Id", "FirstName", "LastName", "Company", "Title", "Phone", "MobilePhone", "Email", "Status", "OwnerId"];
    // Salesforce's owner is an id (OwnerId): never mapped; the status is
    expect(presetMapping(salesforce, "salesforce", "lead", IMPORT_TARGETS.lead).mapping).toEqual(["", "first_name", "last_name", "company_name", "job_title", "", "phone", "email", "status", ""]);
    // a contact has no status or source: the preset keeps those columns away from the synonym match
    const zohoContacts = ["First Name", "Lead Status", "Lead Source", "Contact Owner"];
    const zoho = presetMapping(zohoContacts, "zoho", "contact", IMPORT_TARGETS.contact);
    expect(zoho.mapping).toEqual(["first_name", "", "", "owner"]);
    expect(zoho.marks).toEqual(["preset", "skip", "skip", "preset"]);
  });

  it("takes the first header of an entry the file has (mobile before work)", () => {
    expect(presetMapping(["Business Phone", "Home Phone"], "outlook", "contact", IMPORT_TARGETS.contact).mapping).toEqual(["phone", ""]);
    expect(presetMapping(["Phone", "Mobile"], "zoho", "lead", IMPORT_TARGETS.lead).mapping).toEqual(["", "phone"]);
  });

  it("unknown headers stay unmapped by the preset and go through the ordinary match", () => {
    const headers = ["First Name", "עמודה שלי", "טלפון נוסף", "Favourite colour"];
    const { mapping, marks } = presetMapping(headers, "hubspot", "contact", IMPORT_TARGETS.contact);
    expect(marks).toEqual(["preset", null, null, null]);
    expect(mapping[0]).toBe("first_name");
    expect(mapping[3]).toBe("");
    // the other columns get exactly what the ordinary match gives them, without the target the preset took
    expect(mapping.slice(1)).toEqual(suggestMapping(headers.slice(1), IMPORT_TARGETS.contact.filter((t) => t.key !== "first_name")));
  });

  it("a skipped column is never guessed by the synonym match (Outlook's Title is the honorific)", () => {
    expect(suggestMapping(["Title"], IMPORT_TARGETS.contact)).toEqual(["job_title"]);
    const { mapping, marks } = presetMapping(["Title"], "outlook", "contact", IMPORT_TARGETS.contact);
    expect(mapping).toEqual([""]);
    expect(marks).toEqual(["skip"]);
  });

  it("without a system, or a system without a preset for the object, it is the ordinary match", () => {
    const headers = ["שם מלא", "נייד", "E-mail"];
    for (const [system, entity] of [["", "lead"], [null, "contact"], ["nope", "lead"], ["google_contacts", "deal"], ["hubspot", "task"]] as const) {
      const targets = IMPORT_TARGETS[entity as ImportEntityKey];
      const result = presetMapping(headers, system, entity, targets);
      expect(result.mapping).toEqual(suggestMapping(headers, targets));
      expect(result.marks).toEqual([null, null, null]);
    }
  });

  it("never fills a target the wizard does not offer", () => {
    const targets = IMPORT_TARGETS.contact.filter((t) => !OPENING_KEYS.has(t.key) && t.key !== "company");
    const { mapping, marks } = presetMapping(["Company", "First Name"], "outlook", "contact", targets);
    expect(mapping).toEqual(["", "first_name"]);
    expect(marks[0]).toBeNull();
  });

  it("each system has a Hebrew label, an unchecked flag until a sample file is checked, and a mark line for each kind", () => {
    expect(new Set(SOURCE_SYSTEMS.map((s) => s.key)).size).toBe(SOURCE_SYSTEMS.length);
    for (const s of SOURCE_SYSTEMS) {
      expect(s.label.length).toBeGreaterThan(1);
      expect(s.checked).toBe(false);
    }
    expect(presetMarkText("preset", "HubSpot")).toContain("HubSpot");
    expect(presetMarkText("skip", "HubSpot")).toContain("HubSpot");
    expect(presetMarkText(null, "HubSpot")).toBeNull();
  });
});
