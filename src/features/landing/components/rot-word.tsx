"use client";

import { useEffect, useState } from "react";

import styles from "./landing.module.css";

/** The words that take turns in "כל ה___ של העסק" (the prototype's order). */
export const ROT_WORDS = ["לידים", "לקוחות", "עסקאות", "כסף"] as const;
/** One pass that stops on the last word: 3 x 1.4 s, under the 5 seconds of WCAG 2.2.2. */
export const ROT_SWAP_MS = 1400;

/** The swapping word. The server and prefers-reduced-motion show the first word; screen readers get every word once. */
export function RotWord() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timers = ROT_WORDS.slice(1).map((_, i) => window.setTimeout(() => setIndex(i + 1), ROT_SWAP_MS * (i + 1)));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);
  return (
    <>
      <span className="sr-only">{ROT_WORDS.join(", ")}</span>
      <span aria-hidden="true" className={styles.rot}>
        {ROT_WORDS.map((word, i) => (
          <span key={word} data-on={String(i === index)}>
            {word}
          </span>
        ))}
      </span>
    </>
  );
}
