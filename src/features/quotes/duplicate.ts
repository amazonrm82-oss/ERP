import { z } from "zod";

// QUO-15: what public.quote_duplicate answers, and how the new draft's page says what the copy left out.

export const duplicateResultSchema = z.object({
  quote: z.uuid(),
  skipped: z.array(z.string()),
  discount_dropped: z.boolean(),
});
export type DuplicateResult = z.infer<typeof duplicateResultSchema>;

/** At most this many left-out names travel in the address; the rest are counted. */
export const COPY_NAMES_MAX = 10;
const NAME_MAX = 60;

export type CopyNotice = { names: string[]; more: number; discountDropped: boolean };

function shortName(name: string): string {
  const chars = Array.from(name.trim());
  return chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX - 1).join("")}…` : chars.join("");
}

/** The query string for the new draft's page: `copy=1`, plus what was left out. */
export function copyNoticeParams(result: Pick<DuplicateResult, "skipped" | "discount_dropped">): URLSearchParams {
  const params = new URLSearchParams({ copy: "1" });
  const names = result.skipped.slice(0, COPY_NAMES_MAX).map(shortName);
  for (const name of names) params.append("copy_left", name);
  if (result.skipped.length > names.length) params.set("copy_more", String(result.skipped.length - names.length));
  if (result.discount_dropped) params.set("copy_discount", "1");
  return params;
}

/** Reads the notice back from the page's search params; null when the page was not opened by a copy. */
export function readCopyNotice(search: { copy?: string | string[]; copy_left?: string | string[]; copy_more?: string | string[]; copy_discount?: string | string[] }): CopyNotice | null {
  if (search.copy !== "1") return null;
  const left = search.copy_left === undefined ? [] : Array.isArray(search.copy_left) ? search.copy_left : [search.copy_left];
  const names = left.slice(0, COPY_NAMES_MAX).map(shortName).filter((n) => n.length > 0);
  const more = typeof search.copy_more === "string" && /^\d{1,3}$/.test(search.copy_more) ? Number(search.copy_more) : 0;
  return { names, more, discountDropped: search.copy_discount === "1" };
}

/** The sentences the new draft shows; the first is always there. */
export function copyNoticeText(notice: CopyNotice): { done: string; left: string | null; discount: string | null } {
  const count = notice.names.length + notice.more;
  let left: string | null = null;
  if (count > 0) {
    const list = notice.names.join(", ") + (notice.more > 0 ? ` ועוד ${notice.more}` : "");
    left =
      count === 1
        ? `שורה אחת לא הועתקה, כי המוצר שלה כבר לא מוצע או שהיא לא מתאימה לחבילה: ${list}.`
        : `${count} שורות לא הועתקו, כי המוצרים שלהן כבר לא מוצעים או שהן לא מתאימות לחבילה: ${list}.`;
  }
  return {
    done: "זה עותק של ההצעה, טיוטה חדשה. ההצעה המקורית לא השתנתה.",
    left,
    discount: notice.discountDropped ? "ההנחה על כל ההצעה לא הועתקה, כי הנחות לא כלולות בחבילה." : null,
  };
}
