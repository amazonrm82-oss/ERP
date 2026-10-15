import "server-only";

import { cache } from "react";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { SERIES_KINDS, seriesFrom, type NumberSeries } from "./series";

/** The business's number series of quotes and orders (QUO-03); members read them, no row = the defaults. */
export const getNumberSeries = cache(async (orgId: string): Promise<NumberSeries[]> => {
  const supabase = await createClient();
  const rows = must(
    await supabase.from("number_sequences").select("kind, prefix, start_number, last_number").eq("organization_id", orgId),
    "number sequences",
  );
  return SERIES_KINDS.map((kind) => seriesFrom(kind, rows.find((row) => row.kind === kind)));
});
