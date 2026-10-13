// "לקחתי" (I took it) on a new lead (SPD-01): what public.take_lead() answers,
// and the short Hebrew line the screen and the push show for it.

export type TakeOutcome =
  // the lead had no owner and is now the caller's
  | { ok: true; result: "taken" }
  // the caller's own lead, now marked as seen and being handled
  | { ok: true; result: "acknowledged" }
  // someone else has it (or took it a moment earlier)
  | { ok: false; reason: "taken"; ownerName: string | null }
  // converted to a contact: nothing left to take
  | { ok: false; reason: "closed" };

/** Reads the function's jsonb answer; anything unexpected is null. */
export function parseTakeOutcome(value: unknown): TakeOutcome | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.ok === true && (v.result === "taken" || v.result === "acknowledged")) {
    return { ok: true, result: v.result };
  }
  if (v.ok === false && v.reason === "taken") {
    const name = typeof v.owner_name === "string" && v.owner_name.trim() ? v.owner_name.trim() : null;
    return { ok: false, reason: "taken", ownerName: name };
  }
  if (v.ok === false && v.reason === "closed") {
    return { ok: false, reason: "closed" };
  }
  return null;
}

/** One short line for the outcome. */
export function takeMessage(outcome: TakeOutcome): string {
  if (outcome.ok) {
    return outcome.result === "taken" ? "הליד אצלכם. מעכשיו אתם האחראים עליו." : "סומן שהליד אצלכם ושאתם מטפלים בו.";
  }
  if (outcome.reason === "closed") {
    return "הליד כבר הומר לאיש קשר.";
  }
  return outcome.ownerName ? `הליד כבר אצל ${outcome.ownerName}.` : "הליד כבר אצל מישהו אחר בצוות.";
}

// The service worker's "לקחתי" request carries this header. A cross-site page
// cannot add a custom header without a CORS preflight, which the route never
// answers, so a forged form or link cannot take a lead in someone's name.
export const TAKE_HEADER = "x-crm-take";

/** True for a same-origin request from our own service worker. */
export function isOwnTakeRequest(headers: { get(name: string): string | null }): boolean {
  if (headers.get(TAKE_HEADER) !== "1") return false;
  const site = headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

// --- Who still sees a lead someone took, on the waiting screen (SPD-01) -------
// Owner's decision, 13 October 2026: after "לקחתי" the lead leaves the waiting
// screen of the other employees, and stays (marked "נלקח על ידי …", clock still
// running from its arrival) until it is answered for: the person who took it,
// owners and admins (every lead), and managers of the lead's team (the team or
// a parent team, as app.manages_team()). RLS still decides what anyone reads.

export type WaitingViewer = {
  id: string;
  role: "owner" | "admin" | "manager" | "member" | "viewer";
  // a manager: the teams whose leads they oversee (managed teams and every team under them)
  overseenTeamIds?: readonly string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The PostgREST `or` filter that leaves out leads others took, or null when the viewer sees them all. */
export function takenLeadsFilter(viewer: WaitingViewer): string | null {
  if (viewer.role === "owner" || viewer.role === "admin") return null;
  const parts = ["taken_at.is.null", `owner_id.eq.${viewer.id}`];
  const teams = viewer.role === "manager" ? (viewer.overseenTeamIds ?? []).filter((id) => UUID.test(id)) : [];
  if (teams.length > 0) parts.push(`team_id.in.(${teams.join(",")})`);
  return parts.join(",");
}

/** The line on a waiting lead that someone took; null when nobody pressed "לקחתי". */
export function takenLabel(lead: { takenAt: string | null; ownerId: string | null; ownerName: string | null }, viewerId: string): string | null {
  if (!lead.takenAt || !lead.ownerId) return null;
  if (lead.ownerId === viewerId) return "לקחתם את הליד";
  return `נלקח על ידי ${lead.ownerName ?? "מישהו אחר בצוות"}`;
}
