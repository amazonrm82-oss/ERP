// CHN-05: ready column mappings for the export files of other systems.
//
// A preset names, per object, the columns a system's standard export writes and where each one goes. It is a
// starting point the person sees and changes: every column it filled is marked in the wizard, and the rest of the
// file goes through the ordinary synonym match (`suggestMapping`). Nothing is applied silently.
//
// Three kinds of entries:
//   - a target key: the column's values can be taken as they are (names, phones, emails, dates, amounts);
//   - "list": the values must match a name the business already has (owner, status, source, pipeline, stage),
//     and a name that is not there fails the row; the preset leaves it unmapped and says so, so the person
//     adds the names in settings first, or maps it knowingly;
//   - "skip": a known column of that system that has no place here (an internal id, an honorific), kept away
//     from the synonym match, which would otherwise guess it (Outlook's "Title" is "Mr.", not a job title).
//
// The header lists are the standard export headers as each system documents or writes them (English
// interface). None was checked against a real export file yet (the requirement asks for one per system):
// `SOURCE_SYSTEMS[].checked` stays false until it is.

import { suggestMapping, type ImportEntityKey, type ImportTarget } from "./fields";

export type PresetEntity = Extract<ImportEntityKey, "lead" | "contact" | "company" | "deal">;
type Entry = readonly [to: string | "list" | "skip", headers: readonly string[]];
type Preset = Partial<Record<PresetEntity, readonly Entry[]>>;

export type SourceSystem = { key: string; label: string; checked: boolean; note: string | null; preset: Preset };

// Google Contacts "Google CSV": the current export ("First Name", "E-mail 1 - Value") and the older one
// ("Given Name", "Organization 1 - Name"). A cell may hold several values joined by " ::: ".
const GOOGLE_PEOPLE: readonly Entry[] = [
  ["first_name", ["First Name", "Given Name"]],
  ["last_name", ["Last Name", "Family Name"]],
  ["phone", ["Phone 1 - Value"]],
  ["email", ["E-mail 1 - Value"]],
  ["job_title", ["Organization Title", "Organization 1 - Title"]],
  ["import_note", ["Notes"]],
  ["skip", ["Name", "Middle Name", "Name Prefix", "Name Suffix", "Nickname", "File As", "Labels", "Group Membership", "Phone 1 - Label", "E-mail 1 - Label"]],
];

// Outlook "Comma Separated Values" export. "Title" is the honorific; the mobile number is preferred.
const OUTLOOK_PEOPLE: readonly Entry[] = [
  ["first_name", ["First Name"]],
  ["last_name", ["Last Name"]],
  ["phone", ["Mobile Phone", "Business Phone", "Home Phone", "Primary Phone"]],
  ["email", ["E-mail Address"]],
  ["job_title", ["Job Title"]],
  ["import_note", ["Notes"]],
  ["skip", ["Title", "Middle Name", "Suffix", "Department", "Office Location", "Business Fax", "Home Fax", "Pager", "E-mail 2 Address", "E-mail 3 Address"]],
];

// HubSpot contacts export (default columns of the contacts view).
const HUBSPOT_PEOPLE: readonly Entry[] = [
  ["first_name", ["First Name"]],
  ["last_name", ["Last Name"]],
  ["phone", ["Phone Number", "Mobile Phone Number"]],
  ["email", ["Email"]],
  ["job_title", ["Job Title"]],
  ["original_created_on", ["Create Date"]],
  ["list", ["Contact owner", "Lead Status", "Original Source", "Lifecycle Stage"]],
  ["skip", ["Record ID", "Last Activity Date"]],
];

// Salesforce Data Export (API field names).
const SALESFORCE_PEOPLE: readonly Entry[] = [
  ["first_name", ["FirstName"]],
  ["last_name", ["LastName"]],
  ["phone", ["MobilePhone", "Phone"]],
  ["email", ["Email"]],
  ["job_title", ["Title"]],
  ["original_created_on", ["CreatedDate"]],
  ["import_note", ["Description"]],
  ["list", ["Status", "LeadSource"]],
  ["skip", ["Id", "OwnerId", "AccountId", "CreatedById", "LastModifiedById", "LastModifiedDate", "IsDeleted", "Salutation", "Name"]],
];

// Zoho CRM module export.
const ZOHO_PEOPLE: readonly Entry[] = [
  ["first_name", ["First Name"]],
  ["last_name", ["Last Name"]],
  ["phone", ["Mobile", "Phone"]],
  ["email", ["Email"]],
  ["job_title", ["Title"]],
  ["original_created_on", ["Created Time"]],
  ["import_note", ["Description"]],
  ["list", ["Lead Owner", "Contact Owner", "Lead Source", "Lead Status"]],
  ["skip", ["Record Id", "Salutation", "Modified Time", "Created By", "Modified By"]],
];

// Pipedrive export of people and deals: each header carries its object's name ("Person - Email - Work").
const PIPEDRIVE_PEOPLE: readonly Entry[] = [
  ["full_name", ["Person - Name"]],
  ["first_name", ["Person - First name"]],
  ["last_name", ["Person - Last name"]],
  ["phone", ["Person - Phone - Mobile", "Person - Phone - Work", "Person - Phone"]],
  ["email", ["Person - Email - Work", "Person - Email"]],
  ["original_created_on", ["Person - Person created"]],
  ["list", ["Person - Owner", "Person - Label"]],
  ["skip", ["Person - ID"]],
];

/** The systems offered, in the order of the choice. */
export const SOURCE_SYSTEMS: readonly SourceSystem[] = [
  {
    key: "google_contacts",
    label: "אנשי הקשר של Google",
    checked: false,
    note: "בתא עם כמה ערכים (מופרדים ב-:::) נשאר רק הראשון. כדאי לנקות לפני הייבוא.",
    preset: {
      lead: [...GOOGLE_PEOPLE, ["company_name", ["Organization Name", "Organization 1 - Name"]]],
      contact: [...GOOGLE_PEOPLE, ["company", ["Organization Name", "Organization 1 - Name"]], ["birth_date", ["Birthday"]]],
    },
  },
  {
    key: "outlook",
    label: "Outlook",
    checked: false,
    note: "קובץ שיוצא מ-Outlook בעברית נקרא עם כותרות בעברית, והמיפוי המוכן לא חל עליו.",
    preset: {
      lead: [...OUTLOOK_PEOPLE, ["company_name", ["Company"]]],
      contact: [...OUTLOOK_PEOPLE, ["company", ["Company"]], ["birth_date", ["Birthday"]]],
    },
  },
  {
    key: "hubspot",
    label: "HubSpot",
    checked: false,
    note: null,
    preset: {
      lead: [...HUBSPOT_PEOPLE, ["company_name", ["Company Name"]]],
      contact: [...HUBSPOT_PEOPLE, ["company", ["Company Name"]]],
      company: [
        ["name", ["Company name"]],
        ["phone", ["Phone Number"]],
        ["website", ["Website URL", "Company Domain Name"]],
        ["city", ["City"]],
        ["address_line", ["Street Address"]],
        ["country", ["Country/Region"]],
        ["original_created_on", ["Create Date"]],
        ["list", ["Company owner"]],
        ["skip", ["Record ID", "Last Activity Date"]],
      ],
      deal: [
        ["name", ["Deal Name"]],
        ["amount", ["Amount"]],
        ["expected_close_date", ["Close Date"]],
        ["original_created_on", ["Create Date"]],
        ["list", ["Pipeline", "Deal Stage", "Deal owner"]],
        ["skip", ["Record ID", "Last Activity Date"]],
      ],
    },
  },
  {
    key: "salesforce",
    label: "Salesforce",
    checked: false,
    note: "בייצוא של Salesforce האחראי מופיע כמזהה, ולכן הוא לא מיובא.",
    preset: {
      lead: [...SALESFORCE_PEOPLE, ["company_name", ["Company"]]],
      contact: [...SALESFORCE_PEOPLE, ["birth_date", ["Birthdate"]]],
      company: [
        ["name", ["Name"]],
        ["phone", ["Phone"]],
        ["website", ["Website"]],
        ["city", ["BillingCity"]],
        ["address_line", ["BillingStreet"]],
        ["country", ["BillingCountry"]],
        ["original_created_on", ["CreatedDate"]],
        ["skip", ["Id", "OwnerId", "ParentId", "CreatedById", "LastModifiedById", "LastModifiedDate", "IsDeleted"]],
      ],
      deal: [
        ["name", ["Name"]],
        ["amount", ["Amount"]],
        ["expected_close_date", ["CloseDate"]],
        ["original_created_on", ["CreatedDate"]],
        ["list", ["StageName", "LeadSource"]],
        ["skip", ["Id", "OwnerId", "AccountId", "CreatedById", "LastModifiedById", "LastModifiedDate", "IsDeleted", "Probability"]],
      ],
    },
  },
  {
    key: "zoho",
    label: "Zoho CRM",
    checked: false,
    note: null,
    preset: {
      lead: [...ZOHO_PEOPLE, ["company_name", ["Company"]]],
      contact: [...ZOHO_PEOPLE, ["company", ["Account Name"]], ["birth_date", ["Date of Birth"]]],
      company: [
        ["name", ["Account Name"]],
        ["phone", ["Phone"]],
        ["website", ["Website"]],
        ["city", ["Billing City"]],
        ["address_line", ["Billing Street"]],
        ["country", ["Billing Country"]],
        ["original_created_on", ["Created Time"]],
        ["import_note", ["Description"]],
        ["list", ["Account Owner"]],
        ["skip", ["Record Id", "Modified Time", "Created By", "Modified By"]],
      ],
      deal: [
        ["name", ["Deal Name"]],
        ["amount", ["Amount"]],
        ["expected_close_date", ["Closing Date"]],
        ["company", ["Account Name"]],
        ["original_created_on", ["Created Time"]],
        ["import_note", ["Description"]],
        ["list", ["Deal Owner", "Stage", "Pipeline", "Lead Source"]],
        ["skip", ["Record Id", "Contact Name", "Probability (%)", "Modified Time", "Created By", "Modified By"]],
      ],
    },
  },
  {
    key: "pipedrive",
    label: "Pipedrive",
    checked: false,
    note: null,
    preset: {
      lead: [...PIPEDRIVE_PEOPLE, ["company_name", ["Person - Organization"]]],
      contact: [...PIPEDRIVE_PEOPLE, ["company", ["Person - Organization"]]],
      company: [
        ["name", ["Organization - Name"]],
        ["address_line", ["Organization - Address"]],
        ["original_created_on", ["Organization - Organization created"]],
        ["list", ["Organization - Owner", "Organization - Label"]],
        ["skip", ["Organization - ID"]],
      ],
      deal: [
        ["name", ["Deal - Title"]],
        ["amount", ["Deal - Value"]],
        ["expected_close_date", ["Deal - Expected close date"]],
        ["company", ["Deal - Organization"]],
        ["original_created_on", ["Deal - Deal created"]],
        ["list", ["Deal - Owner", "Deal - Pipeline", "Deal - Stage"]],
        ["skip", ["Deal - ID", "Deal - Contact person", "Deal - Currency", "Deal - Status"]],
      ],
    },
  },
];

export function sourceSystem(key: string | null | undefined): SourceSystem | null {
  return SOURCE_SYSTEMS.find((s) => s.key === key) ?? null;
}

/** Whether the system has a ready mapping for the object. */
export function presetFor(key: string | null | undefined, entity: ImportEntityKey): readonly Entry[] | null {
  const system = sourceSystem(key);
  if (!system) return null;
  return (system.preset as Record<string, readonly Entry[] | undefined>)[entity] ?? null;
}

/** How a column got its choice: by the preset, recognised but left for the person, or not by the preset. */
export type PresetMark = "preset" | "list" | "skip" | null;

/** Header text as a preset compares it: case, spaces, and the punctuation exports differ in. */
export function normalizeHeader(text: string): string {
  return text
    .replace(/^﻿/, "")
    .trim()
    .toLowerCase()
    .replace(/[_\-.:/()%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The mapping for a file: the preset's columns first (each target once, the first header in the entry's order that
 * the file has), then the ordinary synonym match for every column the preset did not name. A target the wizard does
 * not offer (an opening balance for a person who may not set one) is never filled.
 */
export function presetMapping(
  headers: string[],
  systemKey: string | null | undefined,
  entity: ImportEntityKey,
  targets: ImportTarget[],
): { mapping: string[]; marks: PresetMark[] } {
  const mapping: string[] = headers.map(() => "");
  const marks: PresetMark[] = headers.map(() => null);
  const preset = presetFor(systemKey, entity);
  const normalized = headers.map(normalizeHeader);
  const offered = new Set(targets.map((t) => t.key));
  const used = new Set<string>();

  if (preset) {
    for (const [to, names] of preset) {
      if (to === "list" || to === "skip") {
        const wanted = new Set(names.map(normalizeHeader));
        normalized.forEach((h, i) => {
          if (h && marks[i] === null && wanted.has(h)) marks[i] = to;
        });
        continue;
      }
      if (used.has(to) || !offered.has(to)) continue;
      for (const name of names) {
        const n = normalizeHeader(name);
        const index = normalized.findIndex((h, i) => h === n && marks[i] === null);
        if (index >= 0) {
          mapping[index] = to;
          marks[index] = "preset";
          used.add(to);
          break;
        }
      }
    }
  }

  const rest = headers.map((_, i) => i).filter((i) => marks[i] === null);
  const guessed = suggestMapping(
    rest.map((i) => headers[i]),
    targets.filter((t) => !used.has(t.key)),
  );
  rest.forEach((index, k) => {
    mapping[index] = guessed[k] ?? "";
  });
  return { mapping, marks };
}

/** The line under a column the preset handled. */
export function presetMarkText(mark: PresetMark, systemLabel: string): string | null {
  if (mark === "preset") return `מולא לפי ${systemLabel}. אפשר לשנות.`;
  if (mark === "list") return "לא מולא: הערכים צריכים להתאים לשמות שכבר יש אצלכם (משתמשים, סטטוסים, מקורות או שלבים). אפשר לבחור שדה אחרי שבדקתם.";
  if (mark === "skip") return `עמודה של ${systemLabel} שלא מייבאים.`;
  return null;
}
