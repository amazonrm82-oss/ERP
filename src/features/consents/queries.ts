import "server-only";

import { SUBJECT_COLUMN } from "@/features/activities/schema";
import { getUserNames } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import {
  CONSENT_CHANNELS,
  isConsentSource,
  isConsentState,
  LIFT_METHODS,
  type ConsentChannel,
  type ConsentSource,
  type ConsentState,
  type LiftMethod,
} from "./model";

export type ConsentSubject = { kind: "lead" | "contact"; id: string };

export type ConsentEntry = {
  id: string;
  channel: ConsentChannel;
  state: ConsentState;
  source: ConsentSource | null;
  method: string | null;
  wording: string | null;
  // CAP-07 / CNS-04: the version of a server writer's wording (the public form's DRAFT)
  wordingVersion: string | null;
  // an owner's or admin's lift of an opt-out
  liftMethod: LiftMethod | null;
  recordedBy: string | null;
  createdAt: string;
  // CNS-05 undo: this entry ends an import's entry ("cancel"), or an undone import's entry that no longer counts ("cancelled")
  importUndo: "cancel" | "cancelled" | null;
};

export type ChannelConsent = {
  channel: ConsentChannel;
  // the latest entry; null = nothing recorded ("לא ידוע")
  latest: (Omit<ConsentEntry, "id" | "liftMethod" | "wordingVersion" | "importUndo"> & { currentAddress: boolean | null }) | null;
  // CNS-06: the record's own address is blocked for marketing whatever this record's entries say: 'listed' (owners and
  // admins: on the business's blocklist) or 'blocked' (the neutral word for everyone else; also an opt-out or erasure
  // of the same address elsewhere). Display only: senders judge by app.consent_suppressed.
  block: "listed" | "blocked" | null;
  // CAP-07 follow-up: a public-form tick newer than the latest state that waits for a double opt-in (lifts nothing);
  // `method` names the form ("טופס: <name>")
  awaiting: { createdAt: string; method: string | null } | null;
};

export type RecordConsents = { channels: ChannelConsent[]; history: ConsentEntry[] };

// a value this version does not know (a newer state or source) shows as unknown
function asState(value: string): ConsentState {
  return isConsentState(value) ? value : "unknown";
}

/**
 * CNS-03: a lead's or contact's consent per channel (public.consent_current(), the latest entry of
 * each) and the whole history, newest first. RLS shows them to whoever may read the record.
 */
export async function getRecordConsents(orgId: string, subject: ConsentSubject): Promise<RecordConsents> {
  const supabase = await createClient();
  const [current, rows, blockRows] = await Promise.all([
    supabase.rpc("consent_current", { p_org: orgId, p_kind: subject.kind, p_id: subject.id }),
    supabase
      .from("consents")
      .select("id, channel, state, source, method, wording, wording_version, lift_method, recorded_by, created_at, cancels")
      .eq("organization_id", orgId)
      .eq(SUBJECT_COLUMN[subject.kind], subject.id)
      // newest first by the time the consent was given (a conversion copy keeps its time), then by entry order
      .order("created_at", { ascending: false })
      .order("seq", { ascending: false })
      .limit(200),
    supabase.rpc("consent_record_blocks", { p_org: orgId, p_kind: subject.kind, p_id: subject.id }),
  ]);
  const blocks = must(blockRows, "consent record blocks") ?? [];
  const latest = must(current, "consent current") ?? [];
  const history = must(rows, "consents") ?? [];
  const cancelled = new Set(history.flatMap((r) => (r.cancels ? [r.cancels] : [])));
  const names = await getUserNames([...latest.map((r) => r.recorded_by), ...history.map((r) => r.recorded_by)]);
  const name = (id: string | null) => (id ? (names.get(id) ?? null) : null);

  return {
    channels: CONSENT_CHANNELS.map((channel) => {
      const row = latest.find((r) => r.channel === channel);
      const found = blocks.find((b) => b.channel === channel)?.block;
      // history is newest first; consent_current skips awaiting entries, so the newest one after the state is the marker
      const waiting = history.find((r) => r.channel === channel && r.state === "awaiting_confirmation");
      const awaiting =
        waiting && (!row || Date.parse(waiting.created_at) > Date.parse(row.created_at))
          ? { createdAt: waiting.created_at, method: waiting.method }
          : null;
      return {
        channel,
        block: found === "listed" || found === "blocked" ? found : null,
        awaiting,
        latest: row
          ? {
              channel,
              state: asState(row.state),
              source: isConsentSource(row.source) ? row.source : null,
              method: row.method,
              wording: row.wording,
              recordedBy: name(row.recorded_by),
              createdAt: row.created_at,
              currentAddress: row.current_address,
            }
          : null,
      };
    }),
    history: history.flatMap((row) =>
      (CONSENT_CHANNELS as readonly string[]).includes(row.channel)
        ? [
            {
              id: row.id,
              channel: row.channel as ConsentChannel,
              state: asState(row.state),
              source: isConsentSource(row.source) ? row.source : null,
              method: row.method,
              wording: row.wording,
              wordingVersion: row.wording_version,
              liftMethod: (LIFT_METHODS as readonly string[]).includes(row.lift_method ?? "") ? (row.lift_method as LiftMethod) : null,
              recordedBy: name(row.recorded_by),
              createdAt: row.created_at,
              importUndo: row.cancels ? ("cancel" as const) : cancelled.has(row.id) ? ("cancelled" as const) : null,
            },
          ]
        : [],
    ),
  };
}
