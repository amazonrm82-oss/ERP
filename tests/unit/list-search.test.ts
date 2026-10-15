import { describe, expect, it } from "vitest";

import { personSearchFilter, textSearchFilter } from "@/lib/search";
import { searchNorm } from "@/lib/search-norm";

// FXC-11: the list search filters the normalized computed field search_text (the SQL side is tests/db/122).
describe("list search filters", () => {
  it("folds the term like app.search_norm: niqqud, quotes, geresh, final letters, case", () => {
    expect(searchNorm("דָּן כֹּהֵן")).toBe("דנ כהנ");
    expect(searchNorm('כ"ץ ג׳ורג׳ O\'Brien ABC')).toBe("כצ גורג obrien abc");
  });

  it("filters search_text as an exact substring of the folded term", () => {
    expect(textSearchFilter("  דָּן ")).toBe('search_text.like."%דנ%"');
    expect(textSearchFilter('a,b.c(d)')).toBe('search_text.like."%a,b.c(d)%"');
    // quotes and backslashes cannot break out of the quoted value
    expect(textSearchFilter('x"),id.eq.(1')).toBe('search_text.like."%x),id.eq.(1%"');
    expect(textSearchFilter("x\\\\y")).toBe('search_text.like."%xy%"');
    // no search typed: no filter
    expect(textSearchFilter("")).toBeNull();
    expect(textSearchFilter('  "  ')).toBeNull();
    // a term that folds to nothing (only niqqud, geresh or quotes) finds nothing, not every row
    expect(textSearchFilter("״׳")).toBe("id.is.null");
    expect(textSearchFilter("ָ ּ")).toBe("id.is.null");
    expect(textSearchFilter("'")).toBe("id.is.null");
  });

  it("people and companies also match the phone as typed and by digits", () => {
    expect(personSearchFilter("דנה")).toBe('search_text.like."%דנה%",phone.ilike."%דנה%"');
    expect(personSearchFilter("052-123")).toBe('search_text.like."%052-123%",phone.ilike."%052-123%",phone_e164.ilike."%52123%"');
    expect(personSearchFilter("   ")).toBeNull();
    // folded to nothing: the text part matches nothing, the phone as typed still may
    expect(personSearchFilter("׳")).toBe('id.is.null,phone.ilike."%׳%"');
  });
});
