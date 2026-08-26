import { useEffect, useState, useCallback } from "react";
import { supabase } from "./supabaseClient";

// Generic Supabase-table-backed list with Realtime sync — every module view uses this instead of
// writing its own fetch+subscribe logic. Every table it touches has RLS enabled, so each user
// only ever receives rows they're allowed to see.
export function useRealtimeList(table, options = {}) {
  const { orderBy = "created_at", ascending = false, select = "*", filterColumn, filterValue } = options;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const active = !filterColumn || filterValue != null;

  const refetch = useCallback(async () => {
    if (!active) { setRows([]); setLoading(false); return; }
    let q = supabase.from(table).select(select).order(orderBy, { ascending });
    if (filterColumn) q = q.eq(filterColumn, filterValue);
    const { data, error } = await q;
    if (!error) setRows(data || []);
    setLoading(false);
  }, [table, orderBy, ascending, select, filterColumn, filterValue, active]);

  useEffect(() => {
    if (!active) return;
    refetch();
    const pgFilter = filterColumn ? `${filterColumn}=eq.${filterValue}` : undefined;
    const channel = supabase
      .channel(`${table}-realtime-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table, filter: pgFilter }, (payload) => {
        setRows((current) => {
          if (payload.eventType === "INSERT") {
            if (current.some((r) => r.id === payload.new.id)) return current;
            return [payload.new, ...current];
          }
          if (payload.eventType === "UPDATE") return current.map((r) => (r.id === payload.new.id ? payload.new : r));
          if (payload.eventType === "DELETE") return current.filter((r) => r.id !== payload.old.id);
          return current;
        });
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, filterColumn, filterValue, active]);

  return { rows, loading, refetch, setRows };
}
