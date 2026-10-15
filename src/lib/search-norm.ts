// FXC-11: the one normalization of every search, the mirror of app.search_norm() (migration global_search):
// lower case, no niqqud or cantillation (U+0591..U+05C7), no geresh, gershayim or quotes, final letters as regular
// ones. The lists filter public.search_text(<table>), which applies app.search_norm to the row; the term is folded
// here the same way. tests/db/122-list-search compares the two on sample strings: change both together.
// lower() follows the database locale. The hosted database (en_US.UTF-8) lowers "İ" to "i" + U+0307 exactly like
// JavaScript; the local test database (C.UTF-8) gives a plain "i", so "İ" is left out of the mirror test's samples.

const FINALS: Record<string, string> = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };

export function searchNorm(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/[֑-ׇ]/g, "")
    .toLowerCase()
    .replace(/[ךםןףץ]/g, (letter) => FINALS[letter])
    .replace(/[׳״'"]/g, "");
}
