"use client";

import { buttonClasses } from "@/components/ui/button";
import { LogoutIcon } from "@/components/ui/icons";
import { clearSharedOnDevice } from "@/features/share/device";

import { signOutAction } from "../actions";

/**
 * Signs out through a plain form post, so it works before JavaScript loads. With JavaScript it also clears a share kept
 * on this device (WAB-06) while the sign-out is sent.
 */
export function SignOutButton({ className }: { className?: string }) {
  return (
    <form action={signOutAction} onSubmit={() => void clearSharedOnDevice()}>
      <button type="submit" className={className ?? buttonClasses("ghost", "sm")}>
        <LogoutIcon className="size-4.5" />
        יציאה
      </button>
    </form>
  );
}
