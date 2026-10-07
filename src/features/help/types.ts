export type HelpBlock =
  | { p: string }
  | { h: string }
  | { steps: string[] }
  | { list: string[] }
  | { note: string };

export type HelpCategory = "start" | "daily" | "intake" | "data" | "admin" | "security";

export type HelpArticle = {
  slug: string;
  category: HelpCategory;
  title: string;
  summary: string;
  body: HelpBlock[];
};

export const CATEGORY_LABELS: Record<HelpCategory, string> = {
  start: "צעדים ראשונים",
  daily: "עבודה יומיומית",
  intake: "לידים נכנסים ואוטומציות",
  data: "דוחות, ייבוא וייצוא",
  admin: "הגדרות וניהול צוות",
  security: "אבטחה וחשבון",
};

/** All the words of an article, for the search box. */
export function articleText(article: HelpArticle): string {
  const parts = [article.title, article.summary];
  for (const block of article.body) {
    if ("p" in block) parts.push(block.p);
    else if ("h" in block) parts.push(block.h);
    else if ("note" in block) parts.push(block.note);
    else parts.push(...("steps" in block ? block.steps : block.list));
  }
  return parts.join(" ").replace(/\*\*/g, "");
}
