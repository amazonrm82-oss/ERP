"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

import { deletePushSubscriptionAction, savePushSubscriptionAction } from "../actions";

type State = "loading" | "unsupported" | "unconfigured" | "denied" | "off" | "on";

// Inlined at build time; empty when the owner has not set up push yet.
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

function supported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Turns push notifications on or off for this browser (phone or computer). */
export function PushToggle({ orgId }: { orgId: string }) {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function check(): Promise<State> {
      if (!supported()) return "unsupported";
      if (!VAPID_PUBLIC_KEY) return "unconfigured";
      if (Notification.permission === "denied") return "denied";
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      return subscription ? "on" : "off";
    }
    check()
      .catch((): State => "off")
      .then((value) => {
        if (!cancelled) setState(value);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setError(null);
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) }));
      const result = await savePushSubscriptionAction(orgId, subscription.toJSON(), navigator.userAgent);
      if (!result.ok) {
        await subscription.unsubscribe();
        setError(result.message);
        return;
      }
      setState("on");
    } catch {
      setError("לא הצלחנו להפעיל התראות בדפדפן הזה. נסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setError(null);
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        const result = await deletePushSubscriptionAction(orgId, subscription.endpoint);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        await subscription.unsubscribe();
      }
      setState("off");
    } catch {
      setError("לא הצלחנו לבטל את ההתראות. נסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  const messages: Partial<Record<State, string>> = {
    loading: "בודק…",
    unsupported: "הדפדפן הזה לא תומך בהתראות. באייפון: יש להוסיף את האתר למסך הבית (שיתוף ← הוספה למסך הבית) ולפתוח אותו משם.",
    unconfigured: "התראות לנייד עוד לא הוגדרו במערכת.",
    denied: "ההתראות חסומות בדפדפן. אפשר לאשר אותן בהגדרות האתר בדפדפן ואז לחזור לכאן.",
    on: "התראות פעילות בדפדפן הזה.",
    off: "התראות כבויות בדפדפן הזה.",
  };

  return (
    <div className="space-y-2">
      <p className="text-md" role="status">
        {messages[state]}
      </p>
      {state === "off" ? (
        <Button size="sm" onClick={enable} disabled={busy} aria-busy={busy || undefined}>
          {busy ? "מפעיל…" : "הפעלת התראות בדפדפן הזה"}
        </Button>
      ) : null}
      {state === "on" ? (
        <Button variant="secondary" size="sm" onClick={disable} disabled={busy} aria-busy={busy || undefined}>
          {busy ? "מבטל…" : "כיבוי התראות בדפדפן הזה"}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
