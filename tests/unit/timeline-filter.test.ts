import { describe, expect, it } from "vitest";

import { LOGGED_TYPES, parseTimelineFilter, TIMELINE_FILTERS, timelineFilterHref } from "@/features/activities/schema";

// REC-06: filtering a record's timeline by kind of activity.
describe("timeline filter (REC-06)", () => {
  it("no value, an unknown value or a repeated one shows everything", () => {
    for (const value of [undefined, null, "", "nope", "__proto__", "toString", ["call", "note"], 3]) {
      expect(parseTimelineFilter(value)).toEqual({ key: "all", types: null, excludeTypes: null });
    }
  });

  it("each kind maps to its activity types", () => {
    // GAP-12: a note from an imported file sits with the notes
    expect(parseTimelineFilter("note").types).toEqual(["note", "import_note"]);
    expect(parseTimelineFilter("call").types).toEqual(["call"]);
    expect(parseTimelineFilter("meeting").types).toEqual(["meeting"]);
    expect(parseTimelineFilter("message").types).toEqual(["whatsapp", "email", "sms"]);
  });

  it("'changes' is everything a person did not log, so a new system event type is covered too", () => {
    const system = parseTimelineFilter("system");
    expect(system.types).toBeNull();
    expect([...(system.excludeTypes ?? [])].sort()).toEqual([...LOGGED_TYPES.map((t) => t.value), "import_note"].sort());
  });

  it("every logged type is reachable through exactly one filter", () => {
    for (const { value } of LOGGED_TYPES) {
      const matching = TIMELINE_FILTERS.filter((f) => "types" in f && (f.types as readonly string[]).includes(value));
      expect(matching).toHaveLength(1);
    }
  });

  it("the type lists are plain identifiers, safe inside a PostgREST in() list", () => {
    for (const f of TIMELINE_FILTERS) {
      const list = "types" in f ? f.types : "excludeTypes" in f ? f.excludeTypes : [];
      for (const type of list) expect(type).toMatch(/^[a-z_]+$/);
    }
  });

  it("links land on the timeline and drop the parameter for 'all'", () => {
    expect(timelineFilterHref("/o/x/leads/y", "all")).toBe("/o/x/leads/y#timeline-title");
    expect(timelineFilterHref("/o/x/leads/y", "call")).toBe("/o/x/leads/y?tl=call#timeline-title");
  });
});
