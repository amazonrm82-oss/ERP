import { paths } from "@/lib/paths";

// FXC-06: the one place that says what each kind of record is: its table, its
// pages, its names, and which shared features it has. Lists, actions, export,
// import, merge and tags read it instead of keeping their own maps.

type RecordTypeInfo = {
  table: "leads" | "contacts" | "companies" | "deals" | "tasks";
  /** The list page. */
  list: (orgId: string) => string;
  /** The record's own page (tasks have none). */
  page: ((orgId: string, id: string) => string) | null;
  /** Plural, for headings and file names in Hebrew ("לידים"). */
  plural: string;
  /** Singular ("ליד"). */
  singular: string;
  tags: boolean;
  customFields: boolean;
  recycleBin: boolean;
  importable: boolean;
  mergeable: boolean;
};

export const RECORD_TYPES = {
  lead: {
    table: "leads",
    list: paths.leads,
    page: paths.lead,
    plural: "לידים",
    singular: "ליד",
    tags: true,
    customFields: true,
    recycleBin: true,
    importable: true,
    mergeable: true,
  },
  contact: {
    table: "contacts",
    list: paths.contacts,
    page: paths.contact,
    plural: "אנשי קשר",
    singular: "איש קשר",
    tags: true,
    customFields: true,
    recycleBin: true,
    importable: true,
    mergeable: true,
  },
  company: {
    table: "companies",
    list: paths.companies,
    page: paths.company,
    plural: "חברות",
    singular: "חברה",
    tags: true,
    customFields: true,
    recycleBin: true,
    importable: true,
    mergeable: true,
  },
  deal: {
    table: "deals",
    list: paths.deals,
    page: paths.deal,
    plural: "עסקאות",
    singular: "עסקה",
    tags: true,
    customFields: true,
    recycleBin: true,
    // IMP-03
    importable: true,
    mergeable: false,
  },
  task: {
    table: "tasks",
    list: paths.tasks,
    page: null,
    plural: "משימות",
    singular: "משימה",
    tags: false,
    customFields: false,
    recycleBin: false,
    // IMP-03
    importable: true,
    mergeable: false,
  },
} as const satisfies Record<string, RecordTypeInfo>;

export type RecordType = keyof typeof RECORD_TYPES;
export type RecordTable = (typeof RECORD_TYPES)[RecordType]["table"];

export function isRecordType(value: unknown): value is RecordType {
  return typeof value === "string" && Object.hasOwn(RECORD_TYPES, value);
}

/** The table of a record type, typed by the type ("lead" -> "leads"). */
export function recordTable<T extends RecordType>(type: T): (typeof RECORD_TYPES)[T]["table"] {
  return RECORD_TYPES[type].table;
}

/** The record's own page, or the list for a type without one (tasks). */
export function recordPage(type: RecordType, orgId: string, id: string): string {
  const info = RECORD_TYPES[type];
  return info.page ? info.page(orgId, id) : info.list(orgId);
}
