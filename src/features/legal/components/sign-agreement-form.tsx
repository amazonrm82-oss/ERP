"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { signAgreementAction } from "../actions";

type Method = "drawn" | "typed";

/** Full name, a signature (drawn with finger or mouse, or the typed name), and consent. */
export function SignAgreementForm({ next, defaultName }: { next: string; defaultName: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(signAgreementAction, null);
  const failure = state && !state.ok ? state : null;
  const [method, setMethod] = useState<Method>("drawn");
  const [name, setName] = useState(failure?.values?.full_name ?? defaultName);
  const [signature, setSignature] = useState("");

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="method" value={method} />
      <input type="hidden" name="signature" value={method === "drawn" ? signature : ""} />
      <FormError message={failure?.message} />
      <TextField label="שם מלא" name="full_name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">חתימה</legend>
        {/* FXA-09: native radio buttons, so arrow keys move between the choices */}
        <div className="mb-2 flex flex-wrap gap-2">
          {(["drawn", "typed"] as const).map((m) => (
            <label
              key={m}
              className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-md has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${method === m ? "border-accent bg-accent-soft font-semibold text-accent-strong" : "border-line-control"}`}
            >
              <input type="radio" name="signature_method" value={m} checked={method === m} onChange={() => setMethod(m)} className="size-4 accent-accent" />
              {m === "drawn" ? "ציור חתימה" : "הקלדת שם"}
            </label>
          ))}
        </div>
        {method === "drawn" ? (
          <SignaturePad onChange={setSignature} />
        ) : (
          <p className="flex min-h-24 items-center justify-center rounded-md border border-line-control bg-surface px-4 text-3xl italic" aria-live="polite">
            {name.trim() || "השם שלכם יופיע כאן"}
          </p>
        )}
      </fieldset>

      <label className="flex items-start gap-2 text-md">
        <input type="checkbox" name="agree" className="mt-1 size-4 shrink-0" required />
        <span>קראתי את תנאי השימוש, מדיניות הפרטיות והסכם עיבוד המידע, ואני מסכים/ה להם. החתימה האלקטרונית שלי מחייבת כמו חתימה בכתב יד.</span>
      </label>
      <SubmitButton pendingText="שומרים…" className="w-full sm:w-auto">
        חתימה והמשך
      </SubmitButton>
    </form>
  );
}

/** A box to sign in with a finger, pen or mouse. Reports a PNG data URL (empty when cleared). */
function SignaturePad({ onChange }: { onChange: (dataUrl: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // sharp on high-density screens
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0e1c36";
  }, []);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = event.currentTarget.getContext("2d");
    if (!ctx) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const { x, y } = point(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.1, y + 0.1);
    ctx.stroke();
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = event.currentTarget.getContext("2d");
    if (!ctx) return;
    const { x, y } = point(event);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function end(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    setEmpty(false);
    onChange(event.currentTarget.toDataURL("image/png"));
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    setEmpty(true);
    onChange("");
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        aria-label="תיבת חתימה: חתמו עם האצבע או העכבר. אפשר גם לבחור הקלדת שם."
        role="img"
        className="block h-40 w-full touch-none rounded-md border border-line-control bg-surface"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div className="mt-1 flex items-center justify-between text-sm text-ink-soft">
        <span>{empty ? "חתמו בתוך התיבה" : "נחתם"}</span>
        <Button variant="ghost" size="sm" onClick={clear} disabled={empty}>
          ניקוי
        </Button>
      </div>
    </div>
  );
}
