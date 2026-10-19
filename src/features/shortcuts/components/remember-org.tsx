"use client";

import { useEffect } from "react";

import { LAST_ORG_COOKIE, LAST_ORG_COOKIE_MAX_AGE } from "../shortcuts";

/** USR-08: the business open now is the one the app's shortcuts open next time (a cookie on this device). */
export function RememberOrg({ orgId }: { orgId: string }) {
  useEffect(() => {
    document.cookie = `${LAST_ORG_COOKIE}=${orgId}; path=/; max-age=${LAST_ORG_COOKIE_MAX_AGE}; samesite=lax`;
  }, [orgId]);
  return null;
}
