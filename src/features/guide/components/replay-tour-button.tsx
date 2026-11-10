"use client";

import { buttonClasses } from "@/components/ui/button";

import { TOUR_REPLAY_EVENT } from "../tour";

/**
 * UX-05 (א): "סיור במערכת" in the account menu opens the first-visit tour again (it lives in the business frame). The menu
 * closes first the way Escape closes it (focus back on its button), so the tour's window gives focus back there.
 */
export function ReplayTourButton() {
  return (
    <button
      type="button"
      onClick={() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        window.dispatchEvent(new Event(TOUR_REPLAY_EVENT));
      }}
      className={buttonClasses("ghost", "sm", "w-full justify-start")}
    >
      סיור במערכת
    </button>
  );
}
