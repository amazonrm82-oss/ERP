"use client";

import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";

type Props = {
  // the drawing as a PNG data URL, or null while it is empty
  onChange: (image: string | null) => void;
  labelId: string;
};

/**
 * QUO-09: draw a signature with a finger, a pen or a mouse. The typed name is the keyboard alternative offered next to
 * it. The pad is white paper with dark ink in both themes, exported as a PNG on a transparent background.
 */
export function SignaturePad({ onChange, labelId }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const drawn = useRef(false);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ratio = window.devicePixelRatio || 1;
    el.width = el.clientWidth * ratio;
    el.height = el.clientHeight * ratio;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // the pad is paper in both themes, so the stored image reads the same on the owner's screen and on a print
    ctx.strokeStyle = getComputedStyle(el).getPropertyValue("--mx-grey-900").trim() || "black";
  }, []);

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = event.currentTarget.getContext("2d");
    if (!ctx) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const { x, y } = point(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = event.currentTarget.getContext("2d");
    if (!ctx) return;
    const { x, y } = point(event);
    ctx.lineTo(x, y);
    ctx.stroke();
    drawn.current = true;
  }

  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    if (drawn.current && canvas.current) onChange(canvas.current.toDataURL("image/png"));
  }

  function clear() {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    ctx.clearRect(0, 0, el.width, el.height);
    drawn.current = false;
    onChange(null);
  }

  return (
    <div className="space-y-2">
      <canvas
        ref={canvas}
        aria-labelledby={labelId}
        role="img"
        className="h-40 w-full touch-none rounded-md border border-line-control bg-paper"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
      />
      <Button type="button" size="sm" variant="ghost" onClick={clear}>
        ניקוי החתימה
      </Button>
    </div>
  );
}
