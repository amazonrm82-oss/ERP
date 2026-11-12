import { handleWaitlist } from "@/features/landing/waitlist-server";

// LND-13: the landing page's "תודיעו לי כשנפתח" (public.landing_waitlist_submit; CLAUDE.md hard rule 5)
export async function POST(request: Request) {
  return handleWaitlist(request);
}
