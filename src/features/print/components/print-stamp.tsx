"use client";

import { useEffect, useState } from "react";

import { printedAtText } from "../print";

/** The "printed at" line; refreshed when the browser starts printing, so a page left open shows the real time. */
export function PrintStamp({ timeZone, initial }: { timeZone: string; initial: string }) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    const refresh = () => setText(printedAtText(new Date(), timeZone));
    window.addEventListener("beforeprint", refresh);
    return () => window.removeEventListener("beforeprint", refresh);
  }, [timeZone]);
  return <p className="text-sm">{text}</p>;
}
