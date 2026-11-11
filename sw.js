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
 *
 * Notifications:
 *   - push: the server sends Declarative Web Push JSON ({"web_push": 8030, "notification": {...}}).
 *     Newer iPhones show that without waking this worker. When the worker is woken, it shows the same
 *     notification. Every push ends in showNotification, whatever arrived: a push that shows nothing
 *     makes Safari take the permission away.
 *   - notificationclick: opens the app at the notification's own link, which must be inside this
 *     app's scope; anything else opens the app root.
 */
var VERSION = "0.2.1";
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

/* ---------- notifications ---------- */
var FALLBACK_TITLE = "Tandem — open the app";

/* What to show for a push. Never throws: a payload that is missing, not JSON or the wrong shape gets the fallback. */
function readPush(data) {
  var d = null;
  try { d = data ? data.json() : null; } catch (err) { d = null; }
  if (d && typeof d === "object" && d.web_push === 8030) d = d.notification;
  if (!d || typeof d !== "object" || typeof d.title !== "string" || !d.title) return { title: FALLBACK_TITLE, options: { data: { navigate: "" } } };
  var options = { data: { navigate: typeof d.navigate === "string" ? d.navigate : "" } };
  if (typeof d.body === "string") options.body = d.body;
  if (typeof d.tag === "string" && d.tag) options.tag = d.tag;
  if (d.silent === true) options.silent = true;
  return { title: d.title, options: options };
}

/* The link a notification may open: same origin and inside this app's scope, else the app root. */
function appUrl(navigate) {
  var scope = self.registration.scope;
  if (typeof navigate !== "string" || !navigate) return scope;
  try {
    var u = new URL(navigate, scope);
    if (u.origin !== self.location.origin || u.href.indexOf(scope) !== 0) return scope;
    return u.href;
  } catch (err) { return scope; }
}
function tabOf(url) {
  var i = url.indexOf("#"), tab = i >= 0 ? url.slice(i + 1) : "";
  return tab === "pairs" || tab === "dates" || tab === "watch" ? tab : "";
}

self.addEventListener("push", function (e) {
  var n = readPush(e.data);
  e.waitUntil(
    Promise.resolve().then(function () { return self.registration.showNotification(n.title, n.options); })
      .catch(function () { return self.registration.showNotification(FALLBACK_TITLE); })
  );
});

self.addEventListener("notificationclick", function (e) {
  var note = e.notification;
  note.close();
  var url = appUrl(note && note.data ? note.data.navigate : ""), scope = self.registration.scope;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      var open = null;
      for (var i = 0; i < list.length; i++) { if (String(list[i].url).indexOf(scope) === 0) { open = list[i]; break; } }
      if (!open) return self.clients.openWindow(url);
      // Already open: bring it forward and take it to the link. If it cannot be navigated, name the tab instead.
      return Promise.resolve().then(function () { return open.focus(); }).catch(function () { return open; }).then(function (c) {
        var client = c || open;
        var tell = function () { if (tabOf(url)) client.postMessage({ tandem: "route", tab: tabOf(url) }); };
        if (typeof client.navigate !== "function") { tell(); return null; }
        return client.navigate(url).catch(function () { tell(); return null; });
      });
    }).catch(function () { return self.clients.openWindow(url); })
  );
});
