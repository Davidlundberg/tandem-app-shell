/* Tandem service worker.
 *
 * VERSION is in lockstep with APP_VERSION in index.html. Bump both on every
 * shell change; tools/publish_shell.sh refuses to publish otherwise.
 *
 * Strategy:
 *   - Navigations: NETWORK-FIRST with a short timeout, falling back to the cached
 *     shell. A launch with any connectivity renders the deployed build; a slow or
 *     offline launch renders the cached one at once. (Cache-first navigations left
 *     an installed iOS app pinned to an old build in a sibling app.)
 *   - Shell assets (manifest, icons, fonts) and the pinned supabase-js UMD:
 *     cache-first, precached at install.
 *   - Everything else passes straight through and is NEVER cached. That covers
 *     *.supabase.co: sign-in and the travel-api board. The board is live data; a
 *     cached copy would show award space that may be gone. The page keeps its last
 *     board in memory only and marks it stale when a refresh fails.
 * All shell paths are relative so the precache resolves under any Pages subpath.
 * Cache names carry a tandem- prefix because other apps share this origin.
 */
var VERSION = "0.1.0";
var SHELL_CACHE = "tandem-shell-" + VERSION;
var NAV_NETWORK_TIMEOUT_MS = 3000;
var SUPABASE_UMD = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0/dist/umd/supabase.js";
var SHELL = [
  "index.html",
  "manifest.webmanifest",
  "static/icon.svg",
  "static/icon-180.png",
  "static/icon-192.png",
  "static/icon-512.png",
  "static/icon-512-maskable.png",
  "static/fonts/archivo-latin.woff2",
  "static/fonts/hanken-grotesk-latin.woff2",
  "static/fonts/jetbrains-mono-latin.woff2"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) {
      // {cache:"reload"} bypasses the HTTP cache so a version bump precaches the fresh shell.
      var local = SHELL.map(function (u) { return new Request(u, { cache: "reload" }); });
      // CORS mode so the cached response still satisfies the page's SRI check.
      var umd = new Request(SUPABASE_UMD, { mode: "cors", credentials: "omit" });
      return c.addAll(local).then(function () {
        return fetch(umd).then(function (r) { if (r.ok) return c.put(umd, r); }).catch(function () {});
      });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys
        .filter(function (k) { return k.indexOf("tandem-") === 0 && k !== SHELL_CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // Never intercept or cache Supabase (sign-in and the board).
  if (url.hostname === "supabase.co" || url.hostname.slice(-12) === ".supabase.co") return;

  // The pinned supabase-js UMD: cache-first.
  if (req.url === SUPABASE_UMD) {
    e.respondWith(caches.open(SHELL_CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        return hit || fetch(req).then(function (r) { if (r.ok) c.put(req, r.clone()); return r; });
      });
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Navigations: network-first, cached shell after the timeout or when offline.
  if (req.mode === "navigate") {
    e.respondWith(caches.open(SHELL_CACHE).then(function (c) {
      return c.match("index.html").then(function (cached) {
        // The download is never aborted: on a connection slower than the timeout it
        // still finishes into the cache, so the next launch is fresh.
        var network = fetch(new Request("index.html", { cache: "reload" })).then(function (r) {
          if (r && r.ok) { e.waitUntil(c.put("index.html", r.clone()).catch(function () {})); return r; }
          return null;
        }).catch(function () { return null; });
        if (!cached) return network.then(function (r) { return r || fetch(req); });
        var timeout = new Promise(function (res) { setTimeout(function () { res(null); }, NAV_NETWORK_TIMEOUT_MS); });
        return Promise.race([network, timeout]).then(function (winner) {
          if (winner) return winner;
          e.waitUntil(network);
          return cached;
        });
      });
    }));
    return;
  }

  // Shell assets within scope: cache-first. Anything else in scope passes through uncached.
  var scopePath = new URL(self.registration.scope).pathname;
  var rel = url.pathname.indexOf(scopePath) === 0 ? url.pathname.slice(scopePath.length) : null;
  if (rel !== null && SHELL.indexOf(rel) >= 0) {
    e.respondWith(caches.open(SHELL_CACHE).then(function (c) {
      return c.match(rel).then(function (hit) {
        return hit || fetch(req).then(function (r) { if (r.ok) c.put(rel, r.clone()); return r; });
      });
    }));
  }
});
