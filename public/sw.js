/* Praxis service worker (M21 P1, PLT-079, D-1231, D-1280). No build step, same origin only.
 *
 * What it keeps: the static app shell and assets on an explicit allow-list (the hashed /_next/static files and
 * the app icons). What it never keeps: a page, an API answer, an RSC payload, anything with user data, any write,
 * anything under /api/, /blueprint or the Owner-tool paths. Those requests are not touched at all.
 * Offline, a page navigation gets a small built-in page that says so; no earlier page is replayed.
 * There is no push subscription, no notification permission request and no notification code here.
 */
var CACHE = "praxis-shell-v1";
var CACHE_PREFIX = "praxis-shell-";

var STATIC_PREFIXES = ["/_next/static/"];
var STATIC_FILES = [
  "/brand/praxis-app-icon-192.png",
  "/brand/praxis-app-icon-512.png",
  "/icon.png",
  "/apple-icon.png",
];
// Never handled, navigation or not (the proxy answers these per user; some are hidden for most people).
var NEVER_PREFIXES = [
  "/api/",
  "/blueprint",
  "/recommendations",
  "/holdings",
  "/trades",
  "/_praxis-absent",
];
var SIGN_OUT_PATH = "/api/auth/signout";

var OFFLINE_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<title>Praxis is offline</title>" +
  "<style>body{font-family:system-ui,sans-serif;margin:0;padding:2rem 1rem;background:#f5f7fb;color:#111}" +
  "main{max-width:32rem;margin:0 auto}</style></head><body><main>" +
  "<h1>Praxis is offline</h1>" +
  "<p>This device has no connection, so nothing new can load.</p>" +
  "<p>Any figures you saw earlier may be old: prices and signals can move while you are away. " +
  "Reconnect and reload to see today's.</p>" +
  "</main></body></html>";

function underPrefix(path, prefix) {
  return (
    path === prefix ||
    path.indexOf(prefix.charAt(prefix.length - 1) === "/" ? prefix : prefix + "/") === 0
  );
}
function isNever(path) {
  for (var i = 0; i < NEVER_PREFIXES.length; i++) {
    var p = NEVER_PREFIXES[i];
    if (p.charAt(p.length - 1) === "/" ? path.indexOf(p) === 0 : underPrefix(path, p)) return true;
  }
  return false;
}
function isStaticAsset(path) {
  if (path.indexOf("..") !== -1) return false;
  for (var i = 0; i < STATIC_PREFIXES.length; i++) {
    if (path.indexOf(STATIC_PREFIXES[i]) === 0) return true;
  }
  return STATIC_FILES.indexOf(path) !== -1;
}
function hasHeader(request, name) {
  try {
    return (
      !!request.headers &&
      request.headers.get(name) !== null &&
      request.headers.get(name) !== undefined
    );
  } catch (e) {
    return false;
  }
}

self.addEventListener("install", function () {
  // Nothing is fetched up front.
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) {
            return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE;
          })
          .map(function (k) {
            return caches.delete(k);
          }),
      );
    }),
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Signing out drops everything this worker holds. The request itself is not touched.
  if (request.method === "POST" && url.pathname === SIGN_OUT_PATH) {
    event.waitUntil(caches.delete(CACHE));
    return;
  }

  if (request.method !== "GET") return;
  if (isNever(url.pathname)) return;
  // RSC and Next data requests carry user data: never handled.
  if (hasHeader(request, "rsc") || hasHeader(request, "next-router-state-tree")) return;
  if (url.pathname.indexOf("/_next/data/") === 0) return;

  if (isStaticAsset(url.pathname)) {
    event.respondWith(
      caches.match(request).then(function (hit) {
        if (hit) return hit;
        return fetch(request).then(function (res) {
          if (res && res.ok && res.status === 200) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) {
              return c.put(request, copy);
            });
          }
          return res;
        });
      }),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(function () {
        return new Response(OFFLINE_PAGE, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }),
    );
  }
});
