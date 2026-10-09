"use client";

import { useEffect, useState } from "react";

import { waitingText } from "@/lib/waiting-time";

/** A clock that runs from the moment the lead came in (SPD-02). The server renders the first value. */
export function WaitingClock({ since, initial }: { since: string; initial: string }) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    const tick = () => setText(waitingText(Date.now() - Date.parse(since)));
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [since]);
  return <span className="tabular-nums">{text}</span>;
}
