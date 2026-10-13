// Service worker: shows push notifications and opens the right screen on tap,
// and shows a "no connection" page when a page cannot load offline.
// Payload (from the app's push dispatcher): { title, body, url, tag }, and for a
// new lead (SPD-01) also `actions` ([{ action, title }], most important first) and
// `links` ({ take, call, whatsapp }: same-origin paths). Built by
// src/features/notifications/push-payload.ts. A payload without them shows as before.
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
  const links = ownLinks(data.links);
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    dir: "rtl",
    lang: "he",
    data: { url: ownPath(data.url) || "/", links },
  };
  // buttons where the browser shows them (iPhone shows none: a tap opens the screen with all three)
  const max = typeof Notification !== "undefined" && typeof Notification.maxActions === "number" ? Notification.maxActions : 2;
  if (Array.isArray(data.actions) && max > 0) {
    const actions = data.actions
      .filter((a) => a && typeof a.action === "string" && typeof a.title === "string" && links[a.action])
      .slice(0, max)
      .map((a) => ({ action: a.action, title: a.title }));
    if (actions.length > 0) options.actions = actions;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

// only paths of this site, never another address ("/\\evil.example" resolves to another host too)
function ownPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  try {
    return new URL(value, self.location.origin).origin === self.location.origin ? value : null;
  } catch {
    return null;
  }
}

function ownLinks(value) {
  const links = {};
  if (value && typeof value === "object") {
    for (const key of ["take", "call", "whatsapp"]) {
      const path = ownPath(value[key]);
      if (path) links[key] = path;
    }
  }
  return links;
}

function openPath(path) {
  const url = new URL(path || "/", self.location.origin).href;
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        return client.navigate(url).then((c) => (c || client).focus());
      }
    }
    return self.clients.openWindow(url);
  });
}

// "לקחתי" without opening the app: a request with the user's own cookies, then a
// short notification with the answer. When that fails (signed out, offline), the
// screen with the three buttons opens instead.
function takeFromPush(notification) {
  const { url, links } = notification.data || {};
  return fetch(links.take, {
    method: "POST",
    credentials: "same-origin",
    redirect: "manual",
    headers: { "x-crm-take": "1" },
  })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
    .then((answer) => {
      if (!answer || typeof answer.message !== "string") throw new Error("no answer");
      return self.registration.showNotification(answer.ok ? "הליד אצלכם" : "הליד לא נלקח", {
        body: answer.message,
        tag: notification.tag || undefined,
        dir: "rtl",
        lang: "he",
        data: { url: url || "/", links: {} },
      });
    })
    .catch(() => openPath(url));
}

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  notification.close();
  const data = notification.data || {};
  const links = data.links || {};
  if (event.action === "take" && links.take) {
    event.waitUntil(takeFromPush(notification));
    return;
  }
  // call / WhatsApp: the screen opens and starts the call or the chat
  const target = (event.action && links[event.action]) || data.url || "/";
  event.waitUntil(openPath(target));
});
