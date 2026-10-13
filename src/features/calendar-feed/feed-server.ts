import "server-only";

import { APP_NAME } from "@/lib/app";
import { createServiceClient } from "@/lib/supabase/service";

import { buildIcs, isFeedToken, type IcsEvent } from "./ics";

// What public.calendar_feed_events() returns (migration 0102).
type FeedResult =
  | { ok: false; reason?: "rate" }
  | {
      ok: true;
      calendar: { name: string; time_zone: string };
      events: Array<{ id: string; title: string; starts_at: string; ends_at: string; location: string | null; video_url: string | null; status: string; updated_at: string | null }>;
    };

const PLAIN = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

/** The feed path ends in "<token>.ics"; anything else is not a feed. */
export function tokenFromFile(file: string): string | null {
  const token = file.endsWith(".ics") ? file.slice(0, -4) : file;
  return isFeedToken(token) ? token : null;
}

/**
 * The personal calendar feed (CAL-07), fetched by Google Calendar, Outlook or a
 * phone with no session. Approved public secret-link pattern (CLAUDE.md, hard
 * rule 5): the service-role client calls public.calendar_feed_events() and
 * nothing else; the function checks the token and returns only this person's
 * meetings. Every refusal is the same 404, so a wrong token and a turned-off
 * one look alike.
 */
export async function calendarFeedResponse(file: string): Promise<Response> {
  const token = tokenFromFile(file);
  if (!token) {
    return new Response("not found", { status: 404, headers: PLAIN });
  }
  const supabase = createServiceClient();
  if (!supabase) {
    return new Response("unavailable", { status: 503, headers: PLAIN });
  }
  const { data, error } = await supabase.rpc("calendar_feed_events", { p_token: token });
  if (error) {
    return new Response("error", { status: 500, headers: PLAIN });
  }
  const result = data as FeedResult | null;
  if (!result || !result.ok) {
    if (result?.reason === "rate") {
      return new Response("too many requests", { status: 429, headers: { ...PLAIN, "Retry-After": "600" } });
    }
    return new Response("not found", { status: 404, headers: PLAIN });
  }
  const events: IcsEvent[] = result.events.map((e) => ({
    id: e.id,
    title: e.title,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    location: e.location,
    videoUrl: e.video_url,
    status: e.status,
    updatedAt: e.updated_at,
  }));
  const body = buildIcs({ name: `${APP_NAME} · ${result.calendar.name}`, timeZone: result.calendar.time_zone, refresh: true, events });
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="${APP_NAME.toLowerCase()}.ics"`,
      // revoking must take effect at once: nothing in between keeps a copy
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer",
    },
  });
}
