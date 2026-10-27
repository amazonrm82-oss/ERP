// WAB-06: the share kept on this device by the service worker (public/sw.js, cache SHARE_CACHE) is cleared when the
// person signs out on this device, so the next person to sign in never sees it.

/** Mirrors SHARE_CACHE in public/sw.js (unit test). */
export const SHARE_CACHE = "share-v1";

export function clearSharedOnDevice(): Promise<void> {
  try {
    if (typeof caches === "undefined") return Promise.resolve();
    return caches.delete(SHARE_CACHE).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}
