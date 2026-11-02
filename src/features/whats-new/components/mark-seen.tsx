"use client";

import { useEffect, useRef } from "react";

import { markWhatsNewSeenAction } from "../actions";

/** USR-12: opening the page marks the list as seen (once per visit; a failure only leaves the dot). */
export function MarkWhatsNewSeen({ orgId }: { orgId: string }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void markWhatsNewSeenAction(orgId);
  }, [orgId]);
  return null;
}
