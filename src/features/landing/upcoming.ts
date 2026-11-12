import { PUBLIC_ROADMAP_ITEMS } from "@/features/roadmap/public-items";

/**
 * LND-13, owner answer (304) ב: beside the built capabilities that public.plans_public answers, the landing page shows the
 * capabilities on their way, each marked "בקרוב". They come from the SAME static list as the public roadmap
 * (`PUBLIC_ROADMAP_ITEMS`, owner answer 192): no item is written here, and the database answer is untouched.
 */
export const UPCOMING_MARK = "בקרוב";

export type UpcomingCapability = { key: string; title: string; mark: typeof UPCOMING_MARK };

export function landingUpcomingCapabilities(): UpcomingCapability[] {
  return PUBLIC_ROADMAP_ITEMS.map((item) => ({ key: item.key, title: item.title, mark: UPCOMING_MARK }));
}
