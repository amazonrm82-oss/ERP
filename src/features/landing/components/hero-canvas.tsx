"use client";

import { useEffect, useRef } from "react";

import styles from "./landing.module.css";
import { LANDING_MOTION_EVENT, type LandingMotionDetail } from "./motion";

/** "#rrggbb" of a base token from globals.css as "r,g,b" (the canvas needs the numbers to mix in transparency). */
function rgb(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  return m ? `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}` : fallback;
}

/**
 * LND-20 v2 (3): the hero's background, ported from the prototype: a sheet of wave lines in perspective, rolling like a
 * signal, with streaks of light running along it. Canvas 2D only (no library, no WebGL). It starts after the first paint, so it
 * never delays the page; it stops while off screen, while the tab is hidden and while the page's pause button is on; under
 * prefers-reduced-motion it draws one still frame. Decorative: hidden from screen readers.
 */
export function HeroCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const blue = rgb("--mx-ln-blue", "36,87,245");
    const light = rgb("--mx-blue-300", "140,176,255");
    const cyan = rgb("--mx-ln-cyan", "14,116,144");
    const mark = rgb("--mx-ln-mark", "255,216,77");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0;
    let H = 0;
    let t = 0;
    let frame = 0;
    let visible = true;
    let paused = false;
    const streaks: { row: number; u: number; dir: number; len: number }[] = [];
    const ROWS = 26;
    const COLS = 90;

    const size = () => {
      const r = (canvas.parentElement ?? canvas).getBoundingClientRect();
      W = r.width;
      H = r.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const yAt = (row: number, col: number, time: number) => {
      const u = col / COLS;
      const v = row / ROWS;
      const base = H * 0.3 + v * v * H * 0.78; // rows bunch at the horizon and spread toward the viewer
      const amp = 8 + v * 46;
      return base + Math.sin(u * 6.3 + time * 0.9 + v * 2.2) * amp * 0.6 + Math.sin(u * 2.1 - time * 0.5 + v * 5) * amp * 0.4;
    };
    const xAt = (col: number, row: number) => {
      const u = col / COLS;
      const v = row / ROWS;
      return W / 2 + (u - 0.5) * W * (0.55 + v * 0.9);
    };
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      for (let r = 0; r <= ROWS; r++) {
        const v = r / ROWS;
        ctx.beginPath();
        for (let k = 0; k <= COLS; k++) {
          const x = xAt(k, r);
          const y = yAt(r, k, t);
          if (k) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        const g = ctx.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0, `rgba(${blue},0)`);
        g.addColorStop(0.5, `rgba(${light},${0.1 + v * 0.45})`);
        g.addColorStop(1, `rgba(${cyan},0)`);
        ctx.strokeStyle = g;
        ctx.lineWidth = 0.8 + v * 1.2;
        ctx.stroke();
      }
      // faint vertical threads
      for (let k = 0; k <= COLS; k += 6) {
        ctx.beginPath();
        for (let r = 0; r <= ROWS; r++) {
          const x = xAt(k, r);
          const y = yAt(r, k, t);
          if (r) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        ctx.strokeStyle = `rgba(${light},0.08)`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // streaks of light along random rows
      if (!reduce && Math.random() < 0.05 && streaks.length < 6) {
        const u = Math.random() < 0.5 ? 0 : 1;
        streaks.push({ row: 4 + Math.floor(Math.random() * (ROWS - 4)), u, dir: u ? -1 : 1, len: 0.12 });
      }
      for (let i = streaks.length - 1; i >= 0; i--) {
        const s = streaks[i];
        s.u += s.dir * 0.012;
        if (s.u < -0.2 || s.u > 1.2) {
          streaks.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        const n = 14;
        let started = false;
        for (let j = 0; j <= n; j++) {
          const col = (s.u - s.dir * s.len * (j / n)) * COLS;
          if (col < 0 || col > COLS) continue;
          const x = xAt(col, s.row);
          const y = yAt(s.row, col, t);
          if (started) ctx.lineTo(x, y);
          else {
            ctx.moveTo(x, y);
            started = true;
          }
        }
        const head = xAt(s.u * COLS, s.row);
        const g2 = ctx.createLinearGradient(head - s.dir * s.len * W, 0, head, 0);
        g2.addColorStop(0, `rgba(${mark},0)`);
        g2.addColorStop(1, `rgba(${mark},0.95)`);
        ctx.strokeStyle = g2;
        ctx.lineWidth = 2.4;
        ctx.lineCap = "round";
        ctx.stroke();
      }
    };
    const running = () => !reduce && visible && !paused && document.visibilityState === "visible";
    const loop = () => {
      frame = 0;
      if (!running()) return;
      t += 0.016;
      draw();
      frame = requestAnimationFrame(loop);
    };
    const resume = () => {
      if (running() && !frame) frame = requestAnimationFrame(loop);
    };

    const onResize = () => {
      size();
      draw();
    };
    const onVisibility = () => resume();
    const onMotion = (event: Event) => {
      paused = (event as CustomEvent<LandingMotionDetail>).detail.paused;
      resume();
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      resume();
    });

    // after the first paint, so the canvas never competes with the page's first content
    const start = window.setTimeout(() => {
      size();
      draw();
      observer.observe(canvas);
      window.addEventListener("resize", onResize);
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener(LANDING_MOTION_EVENT, onMotion);
      resume();
    }, 120);

    return () => {
      window.clearTimeout(start);
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(LANDING_MOTION_EVENT, onMotion);
    };
  }, []);

  return <canvas ref={ref} className={styles.net} aria-hidden="true" />;
}
