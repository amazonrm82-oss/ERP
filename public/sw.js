// Service worker: shows push notifications and opens the right screen on tap,
// and shows a "no connection" page when a page cannot load offline.
// Payload (from the app's push dispatcher): { title, body, url, tag }
//
// Nothing else is cached: customer data never lands in the browser's cache, and
// every page and API call always goes to the network.

const OFFLINE_CACHE = "offline-v1";
const OFFLINE_URL = "/offline.html";
const OFFLINE_ASSETS = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.addAll(OFFLINE_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== OFFLINE_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method === "GET" && request.mode === "navigate") {
    // the network answers; only when it cannot does the offline page show
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }
  if (request.method === "GET" && OFFLINE_ASSETS.includes(new URL(request.url).pathname) && new URL(request.url).origin === self.location.origin) {
    // the offline page's own image, while offline
    event.respondWith(fetch(request).catch(() => caches.match(request)));
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data ? event.data.text() : "" };
  }
  const title = data.title || "התראה חדשה";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || undefined,
      dir: "rtl",
      lang: "he",
      data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          return client.navigate(url).then((c) => (c || client).focus());
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
