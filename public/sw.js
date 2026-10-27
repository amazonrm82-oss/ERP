// Service worker: shows push notifications and opens the right screen on tap,
// and shows a "no connection" page when a page cannot load offline.
// Payload (from the app's push dispatcher): { title, body, url, tag }, and for a
// new lead (SPD-01) also `actions` ([{ action, title }], most important first) and
// `links` ({ take, call, whatsapp }: same-origin paths). Built by
// src/features/notifications/push-payload.ts. A payload without them shows as before.
//
// Nothing else is cached: customer data never lands in the browser's cache, and
// every page and API call always goes to the network. One exception (WAB-06): a share
// from another app ("שתף ל-Mexuz") is kept in SHARE_CACHE on this device until the
// person saves it to a record or drops it, at most 24 hours and one share at a time,
// so the image is never sent anywhere before the person picks where it goes.
// The addresses mirror src/features/share/share.ts.

const OFFLINE_CACHE = "offline-v1";
const OFFLINE_URL = "/offline.html";
const OFFLINE_ASSETS = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon.svg"];
const SHARE_CACHE = "share-v1";
const SHARE_RECEIVE_PATH = "/app/share/receive";
const SHARE_PAGE_PATH = "/app/share";
const SHARE_ITEM_PREFIX = "/app/share/item/";
const SHARE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SHARE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const SHARE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"];
const SHARE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// the SHA-256 (hex) of the signed-in user's id, sent by the share screen; the first one to open a share owns it
const SHARE_OWNER = /^[0-9a-f]{64}$/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.addAll(OFFLINE_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== OFFLINE_CACHE && key !== SHARE_CACHE).map((key) => caches.delete(key))))
      .then(() => pruneShare())
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const requestUrl = new URL(request.url);
  if (requestUrl.origin === self.location.origin) {
    if (request.method === "POST" && requestUrl.pathname === SHARE_RECEIVE_PATH) {
      // a share comes from the system's share sheet (no site: "none"), never from another site's form.
      // A browser that sends no Sec-Fetch-Site is let through. TO VERIFY ON A DEVICE: what Chrome on
      // Android sends for a share target's POST as the service worker sees it.
      const site = request.headers.get("Sec-Fetch-Site");
      if (site && site !== "none" && site !== "same-origin") {
        event.respondWith(new Response(null, { status: 403 }));
        return;
      }
      event.respondWith(receiveShare(request));
      return;
    }
    if (requestUrl.pathname.startsWith(SHARE_ITEM_PREFIX)) {
      event.respondWith(shareItem(request, requestUrl.pathname.slice(SHARE_ITEM_PREFIX.length), requestUrl.searchParams.get("owner")));
      return;
    }
  }
  if (request.method === "GET" && request.mode === "navigate") {
    // the network answers; only when it cannot does the offline page show
    event.waitUntil(pruneShare());
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

// WAB-06: a share from another app. Kept here only: the text as JSON and the image as it
// came, under a fresh id; any earlier share is dropped. The page reads it, uploads the
// image to the record the person picks with their own session, then asks us to forget it.
function textField(form, name, max) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function receiveShare(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return Response.redirect(new URL(SHARE_PAGE_PATH, self.location.origin).href, 303);
  }
  const id = self.crypto.randomUUID();
  const file = form.get("image");
  const image =
    file && typeof file === "object" && typeof file.size === "number" && file.size > 0 && file.size <= SHARE_IMAGE_MAX_BYTES && SHARE_IMAGE_TYPES.includes(file.type)
      ? file
      : null;
  const item = {
    title: textField(form, "title", 300),
    text: textField(form, "text", 5000),
    url: textField(form, "url", 2000),
    image: image ? { name: (file.name || "").slice(0, 200), type: image.type, size: image.size } : null,
    // an image that was sent but cannot be attached (type or size): the page says so
    imageRefused: Boolean(file && typeof file === "object" && file.size > 0 && !image),
    at: Date.now(),
  };
  try {
    await caches.delete(SHARE_CACHE);
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(SHARE_ITEM_PREFIX + id, new Response(JSON.stringify(item), { headers: { "Content-Type": "application/json" } }));
    if (image) await cache.put(SHARE_ITEM_PREFIX + id + "/image", new Response(image, { headers: { "Content-Type": image.type } }));
  } catch {
    return Response.redirect(new URL(SHARE_PAGE_PATH + "?failed=1", self.location.origin).href, 303);
  }
  return Response.redirect(new URL(SHARE_PAGE_PATH + "?s=" + id, self.location.origin).href, 303);
}

// a share nobody finished is dropped after SHARE_MAX_AGE_MS, checked on every page load
async function pruneShare() {
  try {
    if (!(await caches.has(SHARE_CACHE))) return;
    const cache = await caches.open(SHARE_CACHE);
    for (const key of await cache.keys()) {
      if (key.url.endsWith("/image")) continue;
      const item = await (await cache.match(key)).json().catch(() => null);
      if (!item || typeof item.at !== "number" || Date.now() - item.at > SHARE_MAX_AGE_MS) await caches.delete(SHARE_CACHE);
    }
  } catch {
    // never stands in the way of a page
  }
}

async function shareItem(request, rest, owner) {
  const [id, part] = rest.split("/");
  const gone = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!SHARE_ID.test(id || "") || (part !== undefined && part !== "image")) return gone();
  const cache = await caches.open(SHARE_CACHE);
  const key = SHARE_ITEM_PREFIX + id;
  if (request.method === "DELETE") {
    await Promise.all([cache.delete(key), cache.delete(key + "/image")]);
    return new Response(null, { status: 204 });
  }
  if (request.method !== "GET" || !SHARE_OWNER.test(owner || "")) return gone();
  const stored = await cache.match(key);
  if (!stored) return gone();
  let item = null;
  try {
    item = await stored.json();
  } catch {
    item = null;
  }
  if (!item || typeof item.at !== "number" || Date.now() - item.at > SHARE_MAX_AGE_MS) {
    await caches.delete(SHARE_CACHE);
    return gone();
  }
  // tied to the first signed-in person who opens it; anyone else on this device gets nothing
  if (typeof item.owner !== "string") {
    item.owner = owner;
    await cache.put(key, new Response(JSON.stringify(item), { headers: { "Content-Type": "application/json" } }));
  } else if (item.owner !== owner) {
    return gone();
  }
  if (part === "image") return (await cache.match(key + "/image")) || gone();
  return new Response(JSON.stringify(item), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
