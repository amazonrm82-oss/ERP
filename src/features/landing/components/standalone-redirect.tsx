"use client";

import { useEffect } from "react";

import { paths } from "@/lib/paths";

/**
 * Safety net (LND-08): the landing page is for the browser. Opened inside the
 * installed app (an old install, an old link), it sends the user to sign in.
 */
export function StandaloneRedirect() {
  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) window.location.replace(paths.login);
  }, []);
  return null;
}
