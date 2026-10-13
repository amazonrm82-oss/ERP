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
  // an owner's or admin's lift of an opt-out
  liftMethod: LiftMethod | null;
  recordedBy: string | null;
  createdAt: string;
};

export type ChannelConsent = {
  channel: ConsentChannel;
  // the latest entry; null = nothing recorded ("לא ידוע")
  latest: (Omit<ConsentEntry, "id" | "liftMethod"> & { currentAddress: boolean | null }) | null;
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
  const [current, rows] = await Promise.all([
    supabase.rpc("consent_current", { p_org: orgId, p_kind: subject.kind, p_id: subject.id }),
    supabase
      .from("consents")
      .select("id, channel, state, source, method, wording, lift_method, recorded_by, created_at")
      .eq("organization_id", orgId)
      .eq(SUBJECT_COLUMN[subject.kind], subject.id)
      // newest first by the time the consent was given (a conversion copy keeps its time), then by entry order
      .order("created_at", { ascending: false })
      .order("seq", { ascending: false })
      .limit(200),
  ]);
  const latest = must(current, "consent current") ?? [];
  const history = must(rows, "consents") ?? [];
  const names = await getUserNames([...latest.map((r) => r.recorded_by), ...history.map((r) => r.recorded_by)]);
  const name = (id: string | null) => (id ? (names.get(id) ?? null) : null);

  return {
    channels: CONSENT_CHANNELS.map((channel) => {
      const row = latest.find((r) => r.channel === channel);
      return {
        channel,
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
              liftMethod: (LIFT_METHODS as readonly string[]).includes(row.lift_method ?? "") ? (row.lift_method as LiftMethod) : null,
              recordedBy: name(row.recorded_by),
              createdAt: row.created_at,
            },
          ]
        : [],
    ),
  };
}
