// QUO-10: what the quote page says about the customer's views (public.quote_views, counted by public.quote_public).

export type QuoteViews = { firstViewedAt: string; lastViewedAt: string; count: number };

/** "נצפתה 3 פעמים" / "נצפתה פעם אחת"; null when the customer has not opened it. */
export function quoteViewsCount(views: QuoteViews | null): string | null {
  if (!views || views.count < 1) return null;
  return views.count === 1 ? "נצפתה פעם אחת" : `נצפתה ${views.count.toLocaleString("he-IL")} פעמים`;
}
