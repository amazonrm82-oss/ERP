"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const EVERY_MS = 3_000;
const FOR_MS = 120_000;

/**
 * DOC-07 (owner (398) א): while the background worker asks the provider, the page reads the request again every few seconds
 * for two minutes; after that it says so and the person refreshes by hand.
 */
export function IssueRequestWaiting() {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > FOR_MS) {
        clearInterval(timer);
        setGaveUp(true);
        return;
      }
      router.refresh();
    }, EVERY_MS);
    return () => clearInterval(timer);
  }, [router]);
  return (
    <p role="status" className="text-sm text-ink-soft">
      {gaveUp ? "הספק עוד לא ענה. אפשר לרענן את העמוד מאוחר יותר; המסמך לא יופק פעמיים." : "פונים לספק החשבוניות. העמוד יתעדכן לבד."}
    </p>
  );
}
