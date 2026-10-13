// GAP-01: can this device receive push notifications, and if not, why.
// Pure functions over what the browser reports, so they are unit tested;
// readDeviceCapabilities() (browser only) fills them in.

export type DeviceCapabilities = {
  /** NEXT_PUBLIC_VAPID_PUBLIC_KEY is set: push is configured for the site */
  configured: boolean;
  hasNotification: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  /** Notification.permission, null when the API is missing */
  permission: "default" | "granted" | "denied" | null;
  /** this browser holds a push subscription; null when it could not be checked */
  subscribed: boolean | null;
  /** iPhone or iPad (where push works only from the home screen app) */
  ios: boolean;
  /** opened as an installed app (home screen), not in a browser tab */
  standalone: boolean;
};

export type DeviceState =
  | "ok"
  // push is not set up on the site: nothing the user can fix, so no warning
  | "unconfigured"
  | "ios_install"
  | "unsupported"
  | "denied"
  | "off";

/** Why this device will not get notifications ("ok" when it will). The first cause the user must fix comes first. */
export function deviceState(caps: DeviceCapabilities): DeviceState {
  if (!caps.configured) return "unconfigured";
  // Safari on iPhone shows no Push API in a tab at all: the fix is installing, not another browser
  if (caps.ios && !caps.standalone) return "ios_install";
  if (!caps.hasNotification || !caps.hasServiceWorker || !caps.hasPushManager) return "unsupported";
  if (caps.permission === "denied") return "denied";
  if (caps.subscribed === false || caps.permission !== "granted") return "off";
  return "ok";
}

/** States that show the "this device will not get notifications" bar. */
export function deviceNeedsWarning(state: DeviceState): boolean {
  return state === "ios_install" || state === "unsupported" || state === "denied" || state === "off";
}

/** iPhone, iPod or iPad; iPadOS reports itself as a Mac with a touch screen. */
export function isIosDevice(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return platform === "MacIntel" && maxTouchPoints > 1;
}

export const DEVICE_WARNING_TITLE = "המכשיר הזה לא יקבל התראות";

/** How to fix each state, in short steps. */
export const DEVICE_FIX: Record<"ios_install" | "unsupported" | "denied" | "off", string> = {
  ios_install:
    "באייפון התראות מגיעות רק מהמערכת שעל מסך הבית: בספארי לוחצים על שיתוף ואז על \"הוסף למסך הבית\", פותחים את המערכת מהסמל במסך הבית ומאשרים התראות.",
  unsupported: "הדפדפן הזה לא תומך בהתראות. אפשר לפתוח את המערכת ב-Chrome, ב-Edge, ב-Firefox או ב-Safari בגרסה עדכנית.",
  denied: "ההתראות חסומות בדפדפן. פותחים את הגדרות האתר (הסמל שליד הכתובת), מאשרים התראות וטוענים את הדף מחדש.",
  off: "ההתראות כבויות במכשיר הזה. מפעילים אותן בדף ההתראות, בלחיצה על \"הפעלת התראות בדפדפן הזה\".",
};

/** The browser fires this after push is turned on or off here, so the bar checks again. */
export const PUSH_CHANGED_EVENT = "crm:push-changed";

/** Reads the capabilities in the browser. Never call it during render on the server. */
export async function readDeviceCapabilities(vapidPublicKey: string): Promise<DeviceCapabilities> {
  const hasNotification = "Notification" in window;
  const hasServiceWorker = "serviceWorker" in navigator;
  const hasPushManager = "PushManager" in window;
  let subscribed: boolean | null = null;
  if (hasServiceWorker && hasPushManager) {
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      subscribed = Boolean(await registration?.pushManager.getSubscription());
    } catch {
      subscribed = null;
    }
  }
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
  return {
    configured: vapidPublicKey !== "",
    hasNotification,
    hasServiceWorker,
    hasPushManager,
    permission: hasNotification ? Notification.permission : null,
    subscribed,
    ios: isIosDevice(navigator.userAgent, navigator.platform ?? "", navigator.maxTouchPoints ?? 0),
    standalone,
  };
}
