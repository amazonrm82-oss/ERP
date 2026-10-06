import { buttonClasses } from "@/components/ui/button";
import { LogoutIcon } from "@/components/ui/icons";

import { signOutAction } from "../actions";

/** Signs out through a plain form post, so it works before JavaScript loads. */
export function SignOutButton({ className }: { className?: string }) {
  return (
    <form action={signOutAction}>
      <button type="submit" className={className ?? buttonClasses("ghost", "sm")}>
        <LogoutIcon className="size-4.5" />
        יציאה
      </button>
    </form>
  );
}
