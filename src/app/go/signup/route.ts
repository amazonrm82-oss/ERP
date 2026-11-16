import { after } from "next/server";

import { carriedSource, LANDING_SOURCE_PARAM, notAVisit, signupHrefWithSource } from "@/features/landing/measure";
import { recordLandingEvent } from "@/features/landing/measure-server";

// LND-14: a press on a sign-up button of the landing page. Counted on the server (no script, no cookie), then 303 to the
// sign-up page with the source. A prefetch or a link-preview fetcher is sent on without counting. The source in the link is
// the one the landing page folded; anything else is counted as "other".
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const raw = url.searchParams.get(LANDING_SOURCE_PARAM);
  const source = raw == null ? "direct" : (carriedSource(raw) ?? "other");
  if (!notAVisit(request.headers)) {
    const headers = new Headers(request.headers);
    after(() => recordLandingEvent("signup_click", source, headers));
  }
  return new Response(null, {
    status: 303,
    headers: { location: signupHrefWithSource(source), "cache-control": "no-store", "referrer-policy": "same-origin" },
  });
}
