"use client";

import { useEffect, useState } from "react";

import styles from "./landing.module.css";
import { LANDING_MOTION_EVENT, LANDING_ROOT_ID, type LandingMotionDetail } from "./motion";

function setSvgs(paused: boolean) {
  document.querySelectorAll<SVGSVGElement>("svg[data-landing-svg]").forEach((svg) => (paused ? svg.pauseAnimations() : svg.unpauseAnimations()));
}

/**
 * WCAG 2.2.2: the page's moving parts (the hero's background and product loop, the marquee, the flow's dots, the CTA's
 * gradient) run longer than five seconds, so one button pauses and resumes all of them. Under prefers-reduced-motion
 * nothing moves (CSS, the canvas draws one still frame, the SVG animations are paused here), and the button is not shown.
 */
export function PauseButton() {
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      setReduced(query.matches);
      if (query.matches) setSvgs(true);
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  const toggle = () => {
    const next = !paused;
    setPaused(next);
    document.getElementById(LANDING_ROOT_ID)?.setAttribute("data-paused", String(next));
    setSvgs(next);
    window.dispatchEvent(new CustomEvent<LandingMotionDetail>(LANDING_MOTION_EVENT, { detail: { paused: next } }));
  };

  if (reduced) return null;
  return (
    <button type="button" className={styles.pause} aria-pressed={paused} onClick={toggle}>
      {paused ? "הפעלת האנימציות בדף" : "עצירת האנימציות בדף"}
    </button>
  );
}
