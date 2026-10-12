import { describe, expect, it } from "vitest";

import { formSnapshot, isDirty, linkLeavesPage, type LinkClick } from "@/lib/form-dirty";

type Entry = [string, FormDataEntryValue];

describe("formSnapshot / isDirty (REC-11)", () => {
  const start: Entry[] = [
    ["full_name", "דנה"],
    ["phone", "050-1234567"],
    ["tags", "a"],
    ["tags", "b"],
  ];
  const base = formSnapshot(start);

  it("is clean when the values are the same", () => {
    expect(isDirty(base, formSnapshot([...start]))).toBe(false);
  });

  it("is clean when a change was undone again (touched is not dirty)", () => {
    const typed = formSnapshot([["full_name", "דנהX"], ...start.slice(1)]);
    expect(isDirty(base, typed)).toBe(true);
    expect(isDirty(base, formSnapshot(start))).toBe(false);
  });

  it("does not care about the order between different fields", () => {
    expect(isDirty(base, formSnapshot([start[1], start[0], start[2], start[3]]))).toBe(false);
  });

  it("cares about the order within one field (a list)", () => {
    expect(isDirty(base, formSnapshot([start[0], start[1], ["tags", "b"], ["tags", "a"]]))).toBe(true);
  });

  it("sees a field that appeared or disappeared", () => {
    expect(isDirty(base, formSnapshot([...start, ["disqualify_reason", ""]]))).toBe(true);
    expect(isDirty(base, formSnapshot(start.slice(0, 3)))).toBe(true);
  });

  it("sees a checkbox that was ticked (an entry with the same name)", () => {
    expect(isDirty(base, formSnapshot([...start, ["allow_duplicate", "on"]]))).toBe(true);
  });

  it("ignores React's hidden action fields", () => {
    expect(isDirty(base, formSnapshot([["$ACTION_ID_abc", ""], ...start, ["$ACTION_REF_1", "x"]]))).toBe(false);
  });

  it("treats a value with = or quotes as plain text", () => {
    const a = formSnapshot([["a", "x=y"]]);
    const b = formSnapshot([["a=x", "y"]]);
    expect(a).not.toBe(b);
  });

  it("counts a chosen file, and an empty file input is like no file", () => {
    const empty = new File([], "");
    const chosen = new File(["abc"], "cv.pdf");
    expect(isDirty(formSnapshot([["f", empty]]), formSnapshot([["f", ""]]))).toBe(false);
    expect(isDirty(formSnapshot([["f", empty]]), formSnapshot([["f", chosen]]))).toBe(true);
  });

  it("is never dirty before a starting point was taken", () => {
    expect(isDirty(null, base)).toBe(false);
  });
});

describe("linkLeavesPage (REC-11)", () => {
  const here = "https://crm.example/o/1/leads/2?tab=info";
  const click = (over: Partial<LinkClick>): LinkClick => ({ href: "/o/1/leads", target: "", download: false, button: 0, modifier: false, ...over });

  it("asks for a plain click on a link to another page of the app", () => {
    expect(linkLeavesPage(click({}), here)).toBe(true);
    expect(linkLeavesPage(click({ href: "https://crm.example/o/1/leads/2?tab=files" }), here)).toBe(true);
  });

  it("asks for a link to another site too (the page unloads)", () => {
    expect(linkLeavesPage(click({ href: "https://other.example/" }), here)).toBe(true);
  });

  it("does not ask when the form stays on the screen", () => {
    expect(linkLeavesPage(click({ href: "#notes" }), here)).toBe(false);
    expect(linkLeavesPage(click({ href: "https://crm.example/o/1/leads/2?tab=info#x" }), here)).toBe(false);
    expect(linkLeavesPage(click({ target: "_blank" }), here)).toBe(false);
    expect(linkLeavesPage(click({ modifier: true }), here)).toBe(false);
    expect(linkLeavesPage(click({ button: 1 }), here)).toBe(false);
    expect(linkLeavesPage(click({ download: true }), here)).toBe(false);
    expect(linkLeavesPage(click({ href: "tel:+972501234567" }), here)).toBe(false);
    expect(linkLeavesPage(click({ href: "mailto:a@b.co" }), here)).toBe(false);
  });

  it("does not ask for a file download or a list export (the page stays)", () => {
    expect(linkLeavesPage(click({ href: "/o/1/files/abc" }), here)).toBe(false);
    expect(linkLeavesPage(click({ href: "/o/1/leads/export?format=csv" }), here)).toBe(false);
    expect(linkLeavesPage(click({ href: "/o/1/files" }), here)).toBe(true);
    expect(linkLeavesPage(click({ href: "https://other.example/o/1/files/abc" }), here)).toBe(true);
  });

  it("treats target _self like no target", () => {
    expect(linkLeavesPage(click({ target: "_self" }), here)).toBe(true);
  });
});
