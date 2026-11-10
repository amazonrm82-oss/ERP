import { describe, expect, it } from "vitest";

import { ownerMatch, type Owners } from "@/features/imports/link-lookups";
import {
  cleanName,
  collectListCells,
  creatableCount,
  LIST_CELL_MAX,
  listColumnsOf,
  mapsListColumn,
  MAX_DISTINCT_VALUES,
  missingNames,
  OWNER_LEFT_EMPTY,
  openBeforeClosed,
  pipelineFor,
  type ListSnapshot,
} from "@/features/imports/list-names";
import { nameKey } from "@/features/imports/record-cells";

// CHN-05, owner's answer (245) ג: the names of the file that the business does not have yet.

const lists: ListSnapshot = {
  statuses: ["חדש", "בטיפול", "לא רלוונטי"],
  sources: ["פייסבוק", "Google Ads"],
  pipelines: [
    { id: "p2", name: "שירות", isDefault: false, position: 1, stages: ["פתיחה", "סגור"] },
    { id: "p1", name: "מכירות", isDefault: true, position: 0, stages: ["חדש", "הצעה", "נסגר בהצלחה"] },
  ],
};

const owners: Owners = new Map([
  ["dana@x.co.il", "u1"],
  ["דנה", "u1"],
  ["יוסי כהן", null],
]);
const ownerKnown = (cell: string) => typeof ownerMatch(owners, cell) !== "string";

describe("which columns are read by name", () => {
  it("statuses for leads, sources for leads and deals, stages for deals, owners for every record but products", () => {
    expect(listColumnsOf("lead")).toEqual({ status: true, source: true, stage: false, owner: true });
    expect(listColumnsOf("deal")).toEqual({ status: false, source: true, stage: true, owner: true });
    expect(listColumnsOf("task")).toEqual({ status: false, source: false, stage: false, owner: true });
    expect(listColumnsOf("product").owner).toBe(false);
    // a task's "status" is open / done, not a list
    expect(mapsListColumn("task", ["status"])).toBe(false);
    expect(mapsListColumn("task", ["owner"])).toBe(true);
    expect(mapsListColumn("contact", ["status", "source"])).toBe(false);
    expect(mapsListColumn("deal", ["pipeline"])).toBe(true);
    expect(mapsListColumn("lead", ["full_name"])).toBe(false);
  });
});

describe("collecting the file's names", () => {
  it("each name once, compared as the import compares them (trimmed, spaces folded, without case), first spelling kept", () => {
    const mapping = ["full_name", "status", "source", "owner"];
    const rows = [
      ["א", " ממתין  לתשובה ", "Instagram", "dana@x.co.il"],
      ["ב", "ממתין לתשובה", "instagram", "DANA@X.CO.IL"],
      ["ג", "", "  ", "רוני"],
      ["ד", "חדש", "Instagram ", ""],
    ];
    const cells = collectListCells("lead", mapping, rows);
    expect(cells.statuses).toEqual(["ממתין לתשובה", "חדש"]);
    expect(cells.sources).toEqual(["Instagram"]);
    expect(cells.owners).toEqual(["dana@x.co.il", "רוני"]);
    expect(cells.stages).toEqual([]);
    expect(cells.truncated).toBe(false);
  });

  it("a contact's mapped status column is not read (contacts have no status list)", () => {
    expect(collectListCells("contact", ["status", "owner"], [["חדש", "דנה"]])).toMatchObject({ statuses: [], owners: ["דנה"] });
  });

  it("stages keep the sales process of their own row; a row without a stage still reports its process", () => {
    const cells = collectListCells("deal", ["name", "pipeline", "stage"], [
      ["1", "מכירות", "משא ומתן"],
      ["2", "  מכירות ", "משא  ומתן"],
      ["3", "שירות", "משא ומתן"],
      ["4", "", "הדגמה"],
      ["5", "שיווק", ""],
      ["6", "", ""],
    ]);
    expect(cells.stages).toEqual([
      { pipeline: "מכירות", stage: "משא ומתן" },
      { pipeline: "שירות", stage: "משא ומתן" },
      { pipeline: null, stage: "הדגמה" },
      { pipeline: "שיווק", stage: "" },
    ]);
  });

  it("stops at the distinct-value cap and says so; a long cell is cut", () => {
    const rows = Array.from({ length: MAX_DISTINCT_VALUES + 5 }, (_, i) => [`מקור ${i}`]);
    const cells = collectListCells("lead", ["source"], rows);
    expect(cells.sources).toHaveLength(MAX_DISTINCT_VALUES);
    expect(cells.truncated).toBe(true);
    expect(Array.from(cleanName("א".repeat(LIST_CELL_MAX + 50)))).toHaveLength(LIST_CELL_MAX);
  });
});

describe("the missing names", () => {
  it("statuses and sources not on the list; existing ones in any case or spacing are found", () => {
    const missing = missingNames(
      { statuses: ["חדש", "ממתין לתשובה", "לא  רלוונטי"], sources: ["google ads", "Instagram"], owners: [], stages: [], truncated: false },
      lists,
      ownerKnown,
    );
    expect(missing.statuses).toEqual(["ממתין לתשובה"]);
    expect(missing.sources).toEqual(["Instagram"]);
    expect(creatableCount(missing)).toBe(2);
  });

  it("stages per sales process: the row's own, else the default one; an unknown process is never created", () => {
    const missing = missingNames(
      {
        statuses: [],
        sources: [],
        owners: [],
        stages: [
          { pipeline: "מכירות", stage: "משא ומתן" },
          { pipeline: "מכירות", stage: "הצעה" },
          { pipeline: "שירות", stage: "משא ומתן" },
          { pipeline: null, stage: "הדגמה" },
          { pipeline: null, stage: "משא  ומתן" },
          { pipeline: "שיווק", stage: "חדש" },
          { pipeline: "שיווק", stage: "" },
          { pipeline: "שירות", stage: "" },
        ],
        truncated: false,
      },
      lists,
      ownerKnown,
    );
    expect(missing.stages).toEqual([
      { pipelineId: "p1", pipelineName: "מכירות", names: ["משא ומתן", "הדגמה"] },
      { pipelineId: "p2", pipelineName: "שירות", names: ["משא ומתן"] },
    ]);
    expect(missing.unknownPipelines).toEqual(["שיווק"]);
    expect(creatableCount(missing)).toBe(3);
  });

  it("without a default process the first by position is used, as the import does", () => {
    const noDefault = lists.pipelines.map((p) => ({ ...p, isDefault: false }));
    expect(pipelineFor(noDefault, null)?.id).toBe("p1");
    expect(pipelineFor(noDefault, " שירות ")?.id).toBe("p2");
    expect(pipelineFor([], null)).toBeNull();
    expect(missingNames({ statuses: [], sources: [], owners: [], stages: [{ pipeline: null, stage: "א" }], truncated: false }, { ...lists, pipelines: [] }, ownerKnown).stages).toEqual([]);
  });

  it("owners are never created: an unknown or ambiguous one is listed, and the row's note says no owner is set", () => {
    const missing = missingNames(
      { statuses: [], sources: [], owners: ["dana@x.co.il", "דנה", "יוסי כהן", "רוני"], stages: [], truncated: true },
      lists,
      ownerKnown,
    );
    expect(missing.unknownOwners).toEqual(["יוסי כהן", "רוני"]);
    expect(creatableCount(missing)).toBe(0);
    expect(missing.truncated).toBe(true);
    expect(OWNER_LEFT_EMPTY("רוני", false)).toMatch(/לא נמצא.*לא נקבע אחראי/);
    expect(OWNER_LEFT_EMPTY("יוסי כהן", true)).toMatch(/כמה משתמשים/);
  });

  it("collected and compared with the same key as the import (nameKey)", () => {
    const cells = collectListCells("lead", ["status"], [["  בטיפול  "], ["BeTipul"]]);
    expect(missingNames(cells, lists, ownerKnown).statuses).toEqual(["BeTipul"]);
    expect(nameKey("  א   ב ")).toBe(nameKey("א ב"));
  });
});

describe("where new entries go", () => {
  it("open entries, then the new ones, then the closed ones", () => {
    const existing = [
      { id: "a", kind: "open" },
      { id: "won", kind: "won" },
      { id: "b", kind: "open" },
      { id: "lost", kind: "lost" },
    ];
    expect(openBeforeClosed(existing, ["n1", "n2"])).toEqual(["a", "b", "n1", "n2", "won", "lost"]);
    expect(openBeforeClosed([{ id: "c", kind: "converted" }, { id: "d", kind: "disqualified" }], ["n"])).toEqual(["n", "c", "d"]);
  });
});
