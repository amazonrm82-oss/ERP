"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { IconButton } from "@/components/ui/button";
import { CheckIcon, CloseIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

type Tone = "success" | "error";
type Toast = { id: number; message: string; tone: Tone };

const ToastContext = createContext<((message: string, tone?: Tone) => void) | null>(null);

// long enough to read a short Hebrew sentence twice; an error stays until closed
const SUCCESS_MS = 6000;

/**
 * Short floating messages ("נשמר", "הועבר לסל"). The region exists from the
 * first render, so screen readers announce what is added to it. On a phone it
 * sits above the bottom navigation.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback((message: string, tone: Tone = "success") => {
    const id = next.current++;
    setToasts((list) => [...list.slice(-2), { id, message, tone }]);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-2 bottom-20 z-50 flex flex-col items-center gap-2 md:inset-x-auto md:start-6 md:bottom-6 md:items-start"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (toast.tone !== "success") return;
    const timer = window.setTimeout(() => onDismiss(toast.id), SUCCESS_MS);
    return () => window.clearTimeout(timer);
  }, [toast, onDismiss]);

  return <ToastView message={toast.message} tone={toast.tone} onClose={() => onDismiss(toast.id)} />;
}

/** How one message looks; exported for the gallery. */
export function ToastView({ message, tone, onClose }: { message: string; tone: Tone; onClose?: () => void }) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "mx-toast pointer-events-auto flex w-full max-w-sm items-center gap-2 rounded-lg border bg-surface ps-4 pe-1 text-md shadow-lg",
        tone === "error" ? "border-danger text-danger" : "border-line text-ink",
      )}
    >
      {tone === "success" ? <CheckIcon className="size-5 shrink-0 text-success" /> : null}
      <p className="min-w-0 flex-1 py-3">{message}</p>
      {onClose ? <IconButton label="סגירת ההודעה" icon={<CloseIcon className="size-4.5" />} onClick={onClose} /> : null}
    </div>
  );
}

/** show(message, tone) from anywhere under ToastProvider. */
export function useToast(): (message: string, tone?: Tone) => void {
  const show = useContext(ToastContext);
  if (!show) {
    throw new Error("useToast needs a ToastProvider");
  }
  return show;
}
