"use client";

import { useState, useSyncExternalStore } from "react";

import { APP_NAME } from "@/lib/app";
import { canPromptInstall, isIos, isStandalone, promptInstall, subscribeInstallPrompt } from "@/lib/install-prompt";

type Mode = "none" | "prompt" | "ios";

function currentMode(): Mode {
  if (isStandalone()) return "none";
  if (canPromptInstall()) return "prompt";
  return isIos() ? "ios" : "none";
}

/** "Install the app" item in the account menu: the browser's dialog, or how to do it on an iPhone. */
export function InstallApp() {
  const mode = useSyncExternalStore(subscribeInstallPrompt, currentMode, () => "none" as Mode);
  const [showHelp, setShowHelp] = useState(false);

  if (mode === "none") return null;

  const itemClass = "flex min-h-10 w-full items-center px-4 text-start text-[0.9375rem] hover:bg-canvas";

  if (mode === "prompt") {
    return (
      <li>
        <button type="button" className={itemClass} onClick={() => void promptInstall()}>
          התקנת האפליקציה
        </button>
      </li>
    );
  }

  return (
    <li>
      <button type="button" className={itemClass} aria-expanded={showHelp} onClick={() => setShowHelp((v) => !v)}>
        התקנת האפליקציה
      </button>
      {showHelp ? (
        <p className="px-4 pb-2 text-sm text-ink-soft">
          בספארי: לוחצים על כפתור השיתוף (ריבוע עם חץ למעלה), ואז על &quot;הוספה למסך הבית&quot;. {APP_NAME} ייפתח משם כמו אפליקציה, ויוכל לשלוח התראות.
        </p>
      ) : null}
    </li>
  );
}
