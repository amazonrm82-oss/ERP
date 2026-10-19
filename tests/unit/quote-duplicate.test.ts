import { describe, expect, it } from "vitest";

import { COPY_NAMES_MAX, copyNoticeParams, copyNoticeText, readCopyNotice } from "@/features/quotes/duplicate";

const back = (params: URLSearchParams) => {
  const left = params.getAll("copy_left");
  return readCopyNotice({
    copy: params.get("copy") ?? undefined,
    copy_left: left.length === 1 ? left[0] : left.length ? left : undefined,
    copy_more: params.get("copy_more") ?? undefined,
    copy_discount: params.get("copy_discount") ?? undefined,
  });
};

describe("QUO-15: the notice a copy leaves on the new draft", () => {
  it("a clean copy says only that it is a copy", () => {
    const notice = back(copyNoticeParams({ skipped: [], discount_dropped: false }))!;
    expect(notice).toEqual({ names: [], more: 0, discountDropped: false });
    expect(copyNoticeText(notice)).toEqual({ done: expect.stringContaining("עותק"), left: null, discount: null });
  });

  it("names the lines left out, one or many, and counts what does not fit", () => {
    expect(copyNoticeText(back(copyNoticeParams({ skipped: ["מדף"], discount_dropped: false }))!).left).toBe(
      "שורה אחת לא הועתקה, כי המוצר שלה כבר לא מוצע או שהיא לא מתאימה לחבילה: מדף.",
    );
    const many = Array.from({ length: COPY_NAMES_MAX + 3 }, (_, i) => `שורה ${i + 1}`);
    const notice = back(copyNoticeParams({ skipped: many, discount_dropped: true }))!;
    expect(notice.names).toHaveLength(COPY_NAMES_MAX);
    expect(notice.more).toBe(3);
    const text = copyNoticeText(notice);
    expect(text.left).toMatch(/^13 שורות לא הועתקו/);
    expect(text.left).toContain("ועוד 3");
    expect(text.discount).not.toBeNull();
  });

  it("shortens long names and ignores a page not opened by a copy or a bad count", () => {
    const long = "א".repeat(200);
    expect(Array.from(back(copyNoticeParams({ skipped: [long], discount_dropped: false }))!.names[0])).toHaveLength(60);
    expect(readCopyNotice({})).toBeNull();
    expect(readCopyNotice({ copy: "1", copy_more: "x" })).toEqual({ names: [], more: 0, discountDropped: false });
  });
});
