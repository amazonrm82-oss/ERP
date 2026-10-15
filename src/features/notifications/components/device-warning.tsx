"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { BellIcon, CloseIcon } from "@/components/ui/icons";
import { paths } from "@/lib/paths";

import {
  DEVICE_FIX,
  DEVICE_OFF_LINE,
  DEVICE_OFF_LINK,
  DEVICE_WARNING_TITLE,
  deviceNeedsWarning,
  deviceState,
  PUSH_CHANGED_EVENT,
  readDeviceCapabilities,
  type DeviceState,
} from "../device";

// Inlined at build time; empty when the owner has not set up push yet.
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

// per device: the state the user closed the bar for (a different cause shows it again)
const DISMISS_KEY = "crm:push-warning-dismissed";

function dismissedState(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function rememberDismissed(state: DeviceState) {
  try {
    window.localStorage.setItem(DISMISS_KEY, state);
  } catch {
    // private mode or blocked storage: the bar just comes back next time
  }
}

type Props = {
  orgId: string;
  // the notifications page holds the on/off switch itself, so it needs no link there
  linkToSwitch?: boolean;
};

type DeviceCheck = { state: DeviceState; dismissed: string | null };

/** The device's push state and the bar's dismissal, read in the browser after mount (null until then) and again after push is switched. */
function useDeviceCheck(): DeviceCheck | null {
  const [check, setCheck] = useState<DeviceCheck | null>(null);
  useEffect(() => {
    let cancelled = false;
    function run() {
      readDeviceCapabilities(VAPID_PUBLIC_KEY)
        .then((caps) => {
          if (!cancelled) setCheck({ state: deviceState(caps), dismissed: dismissedState() });
        })
        .catch(() => undefined);
    }
    run();
    window.addEventListener(PUSH_CHANGED_EVENT, run);
    return () => {
      cancelled = true;
      window.removeEventListener(PUSH_CHANGED_EVENT, run);
    };
  }, []);
  return check;
}

/**
 * GAP-01: "this device will not get notifications", with how to fix it.
 * Nothing renders on the server or until the browser has been checked.
 */
export function DeviceWarning({ orgId, linkToSwitch = true }: Props) {
  const check = useDeviceCheck();
  // closed here for this cause (a different cause shows the bar again)
  const [closedFor, setClosedFor] = useState<DeviceState | null>(null);
  if (check === null) {
    return null;
  }
  const { state, dismissed } = check;
  if (!deviceNeedsWarning(state) || dismissed === state || closedFor === state) {
    return null;
  }
  const fixKey = state as keyof typeof DEVICE_FIX;

  return (
    <div role="note" aria-labelledby="device-warning-title" className="mb-5 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-warning">
      <BellIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <p id="device-warning-title" className="font-semibold">
          {DEVICE_WARNING_TITLE}
        </p>
        <p className="text-sm">{DEVICE_FIX[fixKey]}</p>
        {linkToSwitch && state === "off" ? (
          <p className="text-sm">
            <Link href={paths.notifications(orgId)} className="font-medium underline underline-offset-4">
              לדף ההתראות
            </Link>
          </p>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="סגירת ההודעה במכשיר הזה"
        title="סגירת ההודעה במכשיר הזה"
        className="-me-2 -mt-2 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-warning hover:bg-surface"
        onClick={() => {
          rememberDismissed(state);
          setClosedFor(state);
        }}
      >
        <CloseIcon aria-hidden="true" className="size-5" />
      </button>
    </div>
  );
}

/**
 * One line for the setup checklist (GAP-01): whether this device gets
 * notifications, or the fix. Shown whatever the bar's dismissal says.
 */
export function DeviceStatus() {
  const state = useDeviceCheck()?.state ?? null;
  if (state === null || state === "unconfigured") {
    return null;
  }
  if (!deviceNeedsWarning(state)) {
    return (
      <p role="status" className="text-sm text-ink-soft">
        המכשיר הזה מקבל התראות.
      </p>
    );
  }
  return (
    <p role="status" className="text-sm text-warning">
      {`${DEVICE_WARNING_TITLE}. ${DEVICE_FIX[state as keyof typeof DEVICE_FIX]}`}
    </p>
  );
}

/**
 * GAP-01 (owner, 14 October 2026): in the "התראות" card of the account settings, one short line
 * while this device does not get notifications (the bar's own rule), with a link to the
 * notifications page where the device is switched on. Not a bar, and it cannot be closed.
 */
export function DeviceOffLine({ orgId }: { orgId: string }) {
  const state = useDeviceCheck()?.state ?? null;
  if (state === null || !deviceNeedsWarning(state)) {
    return null;
  }
  return (
    <p role="status" className="text-sm text-warning">
      {DEVICE_OFF_LINE}{" "}
      <Link href={paths.notifications(orgId)} className="font-medium underline underline-offset-4">
        {DEVICE_OFF_LINK}
      </Link>
    </p>
  );
}
