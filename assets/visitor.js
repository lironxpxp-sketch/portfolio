/*
 * Visit counting for lironsofer.online (GoatCounter, cookie-free).
 *
 * 1. Loads GoatCounter on any page that doesn't load it itself.
 * 2. Personal links: when someone arrives through a link like ?for=wix
 *    (or #for-wix), every page they open and everything they do on the
 *    site is also recorded under their name, for example:
 *      for/wix               link opened (where they landed)
 *      for/wix/home          opened the homepage
 *      for/wix/cv            opened the CV film
 *      for/wix/cv/45s        stayed 45+ seconds on the CV film
 *      for/wix/contact/email clicked the email button
 *      for/wix/reachlist/... used a tool (any existing project event)
 *    The name is kept only in sessionStorage for that browser tab, so it
 *    is forgotten when the tab is closed. No cookies, no IP or email.
 *
 * Load it on every page with: <script defer src="/assets/visitor.js"></script>
 */
(function () {
  if (!/(^|\.)lironsofer\.online$/.test(location.hostname)) return;

  if (!document.querySelector("script[data-goatcounter]")) {
    var g = document.createElement("script");
    g.async = true;
    g.dataset.goatcounter = "https://lironsofer.goatcounter.com/count";
    g.src = "https://gc.zgo.at/count.js";
    document.head.appendChild(g);
  }

  // Same name clean-up as the homepage, so names match across pages
  function clean(w) {
    w = String(w || "").replace(/[_+-]+/g, " ").replace(/[^\p{L}\p{N} &.']/gu, "").trim().slice(0, 40);
    if (w === w.toLowerCase()) w = w.replace(/(^|\s)\p{L}/gu, function (c) { return c.toUpperCase(); });
    return w;
  }
  var fromUrl = "";
  try { fromUrl = new URLSearchParams(location.search).get("for") || ""; } catch (e) {}
  if (!fromUrl) { var m = location.hash.match(/^#for-([\w-]{1,40})$/); if (m) fromUrl = m[1]; }
  fromUrl = clean(fromUrl);

  var who = fromUrl;
  try {
    if (who) sessionStorage.setItem("pf.for", who);
    else who = sessionStorage.getItem("pf.for") || "";
  } catch (e) {}
  if (!who) return;

  var slug = who.toLowerCase().replace(/\s+/g, "-");
  var page = location.pathname.replace(/index\.html$/, "").replace(/^\/+|\/+$/g, "").replace(/^projects\//, "") || "home";
  var isHome = page === "home";

  function whenReady(fn) {
    var tries = 0;
    (function check() {
      if (window.goatcounter && window.goatcounter.count) return fn(window.goatcounter);
      if (++tries < 60) setTimeout(check, 250);
    })();
  }

  whenReady(function (gc) {
    var send = gc.count;
    function rec(path, title) {
      try { send.call(gc, { path: "for/" + slug + (path ? "/" + path : ""), title: title, event: true }); } catch (e) {}
    }

    // Copy every site event (contact clicks, tool use) into this person's trail
    gc.count = function (vars) {
      var out = send.apply(gc, arguments);
      try {
        if (vars && vars.event && vars.path && String(vars.path).indexOf("for/") !== 0)
          rec(String(vars.path).replace(/^\/+/, ""), who + ": " + (vars.title || vars.path));
      } catch (e) {}
      return out;
    };

    // Landed straight on an inner page (the homepage records its own landing)
    if (fromUrl && !isHome) rec("", "Link opened by " + who);
    // The page they're on (skipped for the homepage landing, already counted)
    if (!(isHome && fromUrl)) rec(page, who + " opened " + document.title);

    // Engagement: 45 seconds with the page actually on screen
    var seen = 0, done = false, timer = setInterval(function () {
      if (!done && document.visibilityState === "visible" && ++seen >= 45) {
        done = true;
        clearInterval(timer);
        rec(page + "/45s", who + " spent 45+ seconds on " + document.title);
      }
    }, 1000);
  });
})();
