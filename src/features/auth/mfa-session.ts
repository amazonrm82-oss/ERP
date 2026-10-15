import { isTransientAuthError } from "@/lib/auth-transient";

/**
 * The second-step screen's check of the session (FXC-10 follow-up): "signed_out" only on an answer about the session
 * (gone, invalid); a passing failure of the sign-in service is "unavailable", and the session is kept.
 */
export type MfaSessionCheck = "ok" | "signed_out" | "unavailable";

export function mfaSessionCheck(error: unknown, hasUser: boolean): MfaSessionCheck {
  if (error) {
    return isTransientAuthError(error) ? "unavailable" : "signed_out";
  }
  return hasUser ? "ok" : "signed_out";
}
