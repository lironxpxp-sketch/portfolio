/*
 * AI backend for lironsofer.online — a Cloudflare Worker.
 * The website sends a job here; this Worker picks the AI that suits it
 * (Claude, GPT or Gemini), adds the secret key, and asks. Keys never reach
 * visitors' browsers. Only connected models are used; others are skipped.
 *
 * Settings (Cloudflare dashboard → your Worker → Settings → Variables):
 *   ANTHROPIC_API_KEY  (Secret)  your key from console.anthropic.com
 *   ROUTES             (Text, optional)    JSON to change which AI handles which job, e.g. {"copy":["openai","claude"]}
 *   OPENAI_API_KEY     (Secret, optional)  key from platform.openai.com: GPT writing (and backup images)
 *   OPENAI_MODEL       (Text, optional)    OpenAI text model, default gpt-5.5
 *   OPENAI_IMAGE_MODEL (Text, optional)    OpenAI image model, default gpt-image-2.5-flare
 *   GEMINI_API_KEY     (Secret, optional)  key from aistudio.google.com: Gemini, used first for web research
 *   GEMINI_MODEL       (Text, optional)    Gemini model, default gemini-3.8-flash
 *   GEMINI_IMAGE_MODEL (Text, optional)    image model, default gemini-nano-banana-2.1 (Nano Banana)
 *   HUNTER_API_KEY     (Secret, optional)  key from hunter.io: finds work emails in Reachlist Builder
 *   GOOGLE_CLIENT_ID   (Text, optional)    OAuth client ID: "Sign in with Google" in Reachlist
 *   GMAIL_SEND         (Text, optional)    set to "on" to send straight from Gmail (needs Google's app review for the public)
 *   TRIP               (KV binding, optional) shared storage for the private family trip page
 *   TRIP_TOKEN         (Secret, optional)  the trip link's access token (printed by tools/build_trip.py)
 *   TRIP_EDIT_CODE     (Secret, optional)  code needed to change the trip schedule or post the daily card
 *   VAPID_PRIVATE      (Secret, optional)  key for trip notifications (JSON printed when it was made)
 *   Cron trigger       (optional)          every 5 minutes, so trip reminders go out on time
 */

// Family trip page: the page encrypts its data with a key that lives only in the
// secret link, so this Worker stores data it can't read. Access needs the link's token.
// Changing the schedule also needs TRIP_EDIT_CODE (when set). Notification texts are
// the one thing stored readable, because the Worker has to send them on time.
const tripHits = new Map();
const scanHits = new Map();
const enc8 = new TextEncoder();
function sameText(a, b) {
  a = String(a || ""); b = String(b || "");
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return diff === 0 && b.length > 0;
}
function tripId(v) { return String(v || "").replace(/[^a-z0-9-]/gi, "").slice(0, 40); }
function b64u(buf) { let s = ""; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unb64u(s) { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function concatBytes(...parts) { const n = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
async function hmac256(key, data) { const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", k, data)); }
async function hkdf(salt, ikm, info, len) { const prk = await hmac256(salt, ikm); return (await hmac256(prk, concatBytes(info, new Uint8Array([1])))).slice(0, len); }

// Web Push (RFC 8291 payload encryption + RFC 8292 VAPID)
async function encryptPush(sub, text) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concatBytes(enc8.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc8.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc8.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concatBytes(enc8.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concatBytes(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function vapidAuth(endpoint, env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE);
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const h = b64u(enc8.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const p = b64u(enc8.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://lironsofer.online" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc8.encode(h + "." + p));
  return "vapid t=" + h + "." + p + "." + b64u(sig) + ", k=" + b64u(concatBytes(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y)));
}
async function sendPush(env, sub, msg) {
  const body = await encryptPush(sub, JSON.stringify(msg));
  const r = await fetch(sub.endpoint, { method: "POST", body, headers: {
    Authorization: await vapidAuth(sub.endpoint, env), "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high" } });
  return r.status;
}
async function pushAll(env, id, msg) {
  if (!env.VAPID_PRIVATE || !env.TRIP) return 0;
  const subs = (await env.TRIP.get("subs:" + id, "json")) || {};
  let sent = 0, changed = false;
  for (const [k, s] of Object.entries(subs)) {
    try {
      const st = await sendPush(env, s, msg);
      if (st === 404 || st === 410) { delete subs[k]; changed = true; } else if (st < 300) sent++;
    } catch { /* one phone failing shouldn't stop the others */ }
  }
  if (changed) await env.TRIP.put("subs:" + id, JSON.stringify(subs));
  return sent;
}
async function sendDueReminders(env) {
  if (!env.TRIP || !env.VAPID_PRIVATE) return;
  const now = Date.now();
  const keys = await env.TRIP.list({ prefix: "rem:" });
  for (const k of keys.keys) {
    const id = k.name.slice(4);
    const rem = await env.TRIP.get(k.name, "json");
    if (!rem || !Array.isArray(rem.list)) continue;
    rem.sent = rem.sent || {};
    let changed = false;
    for (const r of rem.list) {
      if (r.at <= now && r.at > now - 45 * 60_000 && !rem.sent[r.tag]) {
        await pushAll(env, id, { title: r.title, body: r.body, tag: r.tag });
        rem.sent[r.tag] = now; changed = true;
      }
    }
    for (const [t, at] of Object.entries(rem.sent)) if (now - at > 3 * 86_400_000) { delete rem.sent[t]; changed = true; }
    if (changed) await env.TRIP.put(k.name, JSON.stringify(rem));
  }
}

const SCAN_PROMPT = `You read one travel document (flight e-ticket, boarding pass, itinerary receipt or hotel voucher).
Return ONLY a JSON object, no other text:
{"kind":"flight|hotel|other","flight_no":"","airline":"","date":"YYYY-MM-DD","from":"IATA code","to":"IATA code","dep":"HH:MM","arr":"HH:MM","terminal":"","seat":"","booking_code":"","hotel":"","checkin":"YYYY-MM-DD","notes":""}
Use "" for anything not printed on the document. Times are the local times printed. booking_code is the airline/booking reference (PNR), usually 6 letters/digits.
Never include passenger names, passport or ID numbers, e-ticket numbers or payment details. "notes": at most one short line of useful info (e.g. baggage allowance), in English.`;

async function tripPost(body, env, origin, ctx) {
  if (!env.TRIP || !env.TRIP_TOKEN) return reply(404, { code: "not_configured", message: "Trip storage isn't connected" }, origin);
  const op = ["tripSave", "tripProg", "tripBlobPut", "tripTickets", "tripPushSub", "tripReminders", "tripScan", "tripPushTest"].find((k) => body[k] && typeof body[k] === "object");
  const t = op && body[op];
  if (!t || !sameText(t.tok, env.TRIP_TOKEN)) return reply(403, { code: "bad_token", message: "Not allowed" }, origin);
  const id = tripId(t.id);
  if (!id) return reply(400, { code: "invalid_request", message: "Missing trip id" }, origin);
  const later = (p) => (ctx && ctx.waitUntil ? ctx.waitUntil(p.catch(() => {})) : p.catch(() => {}));

  if (op === "tripSave") {
    if (env.TRIP_EDIT_CODE && !sameText(t.code, env.TRIP_EDIT_CODE)) return reply(403, { code: "bad_code", message: "Wrong edit code" }, origin);
    if (typeof t.enc !== "string" || !t.enc || t.enc.length > 380_000) return reply(400, { code: "invalid_request", message: "Missing trip data" }, origin);
    const current = (await env.TRIP.get("trip:" + id, "json")) || { rev: 0 };
    if (Number(t.rev) !== Number(current.rev || 0)) return reply(409, { code: "conflict", message: "Someone saved a newer version", rev: current.rev }, origin);
    if (current.enc) {
      await env.TRIP.put("hist:" + id + ":" + current.rev, JSON.stringify(current));
      const idx = ((await env.TRIP.get("histidx:" + id, "json")) || []).filter((r) => r !== current.rev);
      idx.push(current.rev);
      while (idx.length > 10) await env.TRIP.delete("hist:" + id + ":" + idx.shift());
      await env.TRIP.put("histidx:" + id, JSON.stringify(idx));
    }
    const next = { rev: (current.rev || 0) + 1, enc: t.enc, savedAt: new Date().toISOString() };
    await env.TRIP.put("trip:" + id, JSON.stringify(next));
    if (t.notify) later(pushAll(env, id, { title: "עדכון מהבית", body: String(t.notify).slice(0, 200), tag: "upd-" + next.rev }));
    return reply(200, { rev: next.rev }, origin);
  }
  if (op === "tripProg") {
    const set = t.set && typeof t.set === "object" ? t.set : null;
    const keys = set ? Object.keys(set) : [];
    if (!keys.length || keys.length > 200) return reply(400, { code: "invalid_request", message: "Nothing to save" }, origin);
    const prog = (await env.TRIP.get("prog:" + id, "json")) || {};
    for (const k of keys) {
      const v = set[k];
      if (k.length > 80 || !/^[ADK]:/.test(k)) continue;
      if (v === null) prog[k] = null;
      else if (typeof v === "string" && v.length <= 12) prog[k] = v;
    }
    if (Object.keys(prog).length > 4000) return reply(413, { code: "too_large", message: "Too many marks" }, origin);
    await env.TRIP.put("prog:" + id, JSON.stringify(prog));
    return reply(200, { ok: true }, origin);
  }
  if (op === "tripBlobPut") {
    if (typeof t.enc !== "string" || !t.enc || t.enc.length > 4_500_000) return reply(400, { code: "invalid_request", message: "File missing or too large" }, origin);
    const bid = b64u(crypto.getRandomValues(new Uint8Array(12)));
    await env.TRIP.put("blob:" + id + ":" + bid, t.enc);
    return reply(200, { blob: bid }, origin);
  }
  if (op === "tripTickets") {
    if (typeof t.enc !== "string" || !t.enc || t.enc.length > 200_000) return reply(400, { code: "invalid_request", message: "Missing tickets" }, origin);
    await env.TRIP.put("tickets:" + id, JSON.stringify({ enc: t.enc, savedAt: new Date().toISOString() }));
    return reply(200, { ok: true }, origin);
  }
  if (op === "tripPushSub") {
    const s = t.sub;
    if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) return reply(400, { code: "invalid_request", message: "Bad subscription" }, origin);
    const subs = (await env.TRIP.get("subs:" + id, "json")) || {};
    subs[s.endpoint] = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
    if (Object.keys(subs).length > 30) delete subs[Object.keys(subs)[0]];
    await env.TRIP.put("subs:" + id, JSON.stringify(subs));
    return reply(200, { ok: true, push: !!env.VAPID_PRIVATE }, origin);
  }
  if (op === "tripPushTest") {
    const sent = await pushAll(env, id, { title: "בדיקה", body: "ההתראות עובדות. נסיעה טובה!", tag: "test" });
    return reply(200, { sent, push: !!env.VAPID_PRIVATE }, origin);
  }
  if (op === "tripReminders") {
    const list = Array.isArray(t.list) ? t.list.slice(0, 400).filter((r) => r && Number.isFinite(r.at) && typeof r.tag === "string")
      .map((r) => ({ at: Math.round(r.at), tag: r.tag.slice(0, 60), title: String(r.title || "").slice(0, 120), body: String(r.body || "").slice(0, 300) })) : [];
    const cur = (await env.TRIP.get("rem:" + id, "json")) || {};
    await env.TRIP.put("rem:" + id, JSON.stringify({ list, sent: cur.sent || {} }));
    return reply(200, { ok: true, count: list.length }, origin);
  }
  if (op === "tripScan") {
    if (!env.ANTHROPIC_API_KEY) return reply(400, { code: "not_configured", message: "No AI model is connected" }, origin);
    const mime = /^image\/(png|jpeg|webp|gif)$/.test(t.mime) ? t.mime : "";
    if (!mime || typeof t.image !== "string" || t.image.length > 5_500_000) return reply(400, { code: "invalid_request", message: "Send one image up to 4 MB" }, origin);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODELS.default, max_tokens: 700, messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mime, data: t.image } },
        { type: "text", text: SCAN_PROMPT }] }] }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) return reply(res.status === 429 ? 429 : 502, { code: res.status === 429 ? "rate_limited" : "upstream_error", message: "Couldn't read the document" }, origin);
    const text = (j.content || []).map((c) => c.text || "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    let out = null; try { out = m ? JSON.parse(m[0]) : null; } catch { out = null; }
    if (!out) return reply(422, { code: "unreadable", message: "No ticket details found" }, origin);
    return reply(200, { ticket: out }, origin);
  }
  return reply(400, { code: "invalid_request", message: "Unknown request" }, origin);
}

const ALLOWED_ORIGINS = [
  "https://lironsofer.online",
  "https://www.lironsofer.online",
];

const MODELS = {
  quick: "claude-haiku-5-5",
  default: "claude-sonnet-5-5",
  complex: "claude-sonnet-5-5", // kept on Sonnet to control cost
};

// Which AI handles which job, best first. Override with a ROUTES variable (JSON) in Cloudflare.
const ROUTES = {
  research: ["gemini", "openai", "claude"],  // live web research (Google Search first)
  site: ["claude", "openai", "gemini"],      // Creative Studio: reading a brand's website
  creative: ["openai", "claude", "gemini"],  // Creative Studio: concepts, tone and ad copy
  copy: ["claude", "openai", "gemini"],      // concepts, ad copy, briefs
  art: ["claude", "openai", "gemini"],       // art-directed ad illustrations (SVG)
};

const MAX_PROMPT_CHARS = 60_000; // site text added to a prompt is capped to this
const MAX_BODY_BYTES = 60_000;   // largest prompt accepted
const MAX_OUTPUT_TOKENS = 6000;  // longest answer
const PER_IP_LIMIT = 40;         // AI calls per visitor...
const PER_IP_WINDOW_MS = 10 * 60 * 1000; // ...per 10 minutes (best effort)

const hits = new Map();
const imageHits = new Map();
const PER_IP_IMAGES = 40; // ad images per visitor per 10 minutes
const suggestHits = new Map();
const PER_IP_SUGGEST = 300; // company-name autocomplete lookups per visitor per 10 minutes
const peopleHits = new Map();
const PER_IP_PEOPLE = 80;   // email lookups per visitor per 10 minutes
const peopleCache = new Map(); // domain -> Hunter result, saves credits on repeat lookups
const suggestCache = new Map();
const UA = "LironSoferPortfolio/1.0 (https://lironsofer.online; lironsofer.online tools)";

// Company-name autocomplete from Wikidata (free, no key): companies that list an official website
async function suggestCompanies(q) {
  const key = q.toLowerCase();
  if (suggestCache.has(key)) return suggestCache.get(key);
  const api = "https://www.wikidata.org/w/api.php?format=json&origin=*&";
  let found = [];
  try {
    const r = await fetch(api + new URLSearchParams({ action: "wbsearchentities", search: q, language: "en", uselang: "en", type: "item", limit: "15" }), { headers: { "user-agent": UA }, signal: AbortSignal.timeout(5000) });
    found = ((await r.json()).search || []).filter((x) => x && x.id);
  } catch { return []; }
  if (!found.length) return [];
  let ents = {};
  try {
    const r = await fetch(api + new URLSearchParams({ action: "wbgetentities", ids: found.map((x) => x.id).join("|"), props: "claims", languages: "en" }), { headers: { "user-agent": UA }, signal: AbortSignal.timeout(5000) });
    ents = (await r.json()).entities || {};
  } catch { return []; }
  const NOT = new Set(["Q5", "Q515", "Q6256", "Q3624078", "Q1549591", "Q482994", "Q7366", "Q11424", "Q5398426", "Q486972", "Q532", "Q3957", "Q13442814", "Q4167410"]);
  const BIZ = /(company|compan|corporation|business|enterprise|software|technology|startup|brand|manufacturer|retailer|platform|firm|provider|bank|airline|agency|service|developer|publisher|network|marketplace|app|operator|chain|group|conglomerate|maker|producer|studio|media|insurer|fintech|saas)/i;
  const out = [];
  for (const x of found) {
    const c = (ents[x.id] || {}).claims || {};
    const site = c.P856?.[0]?.mainsnak?.datavalue?.value;
    if (!site || !/^https?:\/\//i.test(site)) continue;
    const kinds = (c.P31 || []).map((k) => k.mainsnak?.datavalue?.value?.id).filter(Boolean);
    if (kinds.some((k) => NOT.has(k))) continue;
    const desc = String(x.description || "");
    if (/(city|town|village|municipality|human|album|song|film|footballer|singer|actor|river|mountain|novel|episode|family name|given name)/i.test(desc)) continue;
    let domain = "";
    try { domain = new URL(site).hostname.replace(/^www\./, ""); } catch { continue; }
    out.push({ name: String(x.label || x.match?.text || "").slice(0, 80), description: desc.slice(0, 90), website: site, domain, biz: BIZ.test(desc) ? 1 : 0 });
  }
  out.sort((a, b) => b.biz - a.biz);
  const seen = new Set();
  const list = out.filter((o) => !seen.has(o.domain) && seen.add(o.domain)).slice(0, 7).map(({ biz, ...o }) => o);
  if (suggestCache.size > 2000) suggestCache.clear();
  suggestCache.set(key, list);
  return list;
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function reply(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors(origin) },
  });
}

function overLimit(ip, map = hits, limit = PER_IP_LIMIT) {
  const now = Date.now();
  const list = (map.get(ip) || []).filter((t) => now - t < PER_IP_WINDOW_MS);
  list.push(now);
  map.set(ip, list);
  if (map.size > 5000) map.clear();
  return list.length > limit;
}

// Read a website's own page (title, description, headings, visible text) so new
// sites that search engines haven't indexed yet can still be understood.
async function readSite(input, deep = false, brand = false) {
  let url;
  try { url = new URL(/^https?:\/\//i.test(input) ? input : "https://" + input); } catch { return ""; }
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || /(^|\.)(localhost|local|internal)$/.test(host)) return "";
  let res;
  try {
    res = await fetch(url.toString(), {
      headers: { "user-agent": "Mozilla/5.0 (compatible; LironSoferPortfolio/1.0)", accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
  } catch { return ""; }
  if (!res.ok || !/html/i.test(res.headers.get("content-type") || "")) return "";
  const html = (await res.text()).slice(0, 400000);
  const dec = (t) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  const meta = (re) => { const m = html.match(re); return m ? dec(m[1]).trim() : ""; };
  const title = meta(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const desc = meta(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) || meta(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);
  const ogt = meta(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i);
  const ogd = meta(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
  const abs = (u) => { try { return u ? new URL(u, res.url || url).toString() : ""; } catch { return ""; } };
  const ogi = abs(meta(/<meta[^>]+property=["']og:image(?::url)?["'][^>]*content=["']([^"']*)["']/i) || meta(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:image["']/i));
  const icon = abs(meta(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*href=["']([^"']*)["']/i) || meta(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']*)["']/i));
  const body = dec(html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim().slice(0, 6000);
  const parts = [
    `Address: ${res.url || url.toString()}`,
    title && `Page title: ${title}`,
    desc && `Meta description: ${desc}`,
    ogt && ogt !== title && `Share title: ${ogt}`,
    ogd && ogd !== desc && `Share description: ${ogd}`,
    ogi && `Main image: ${ogi}`,
    icon && `Logo or icon: ${icon}`,
    body && `Visible text: ${body}`,
  ].filter(Boolean);
  if (parts.length <= 1) return "";
  if (brand) {
    // Brand signals for ad design: theme colour, most-used colours, fonts and a logo image
    const theme = meta(/<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']*)["']/i) || meta(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']theme-color["']/i);
    let css = (html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).join("\n").slice(0, 200000) + " " + (html.match(/style=["'][^"']*["']/gi) || []).join(" ");
    const sheetHrefs = [...html.matchAll(/<link[^>]+>/gi)].map((m) => m[0]).filter((t) => /rel=["'][^"']*stylesheet/i.test(t)).map((t) => (t.match(/href=["']([^"']+)["']/i) || [])[1]).filter(Boolean);
    const sheets = await Promise.all(sheetHrefs.filter((h) => !/fonts\.googleapis/i.test(h)).slice(0, 2).map(async (h) => {
      try { const r = await fetch(abs(h), { headers: { "user-agent": "Mozilla/5.0 (compatible; LironSoferPortfolio/1.0)" }, signal: AbortSignal.timeout(5000) }); return r.ok ? (await r.text()).slice(0, 300000) : ""; } catch { return ""; }
    }));
    css += " " + sheets.join(" ");
    const count = new Map();
    for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
      let h = m[1].toLowerCase(); if (h.length === 3) h = h.split("").map((c) => c + c).join("");
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      if (Math.max(r, g, b) - Math.min(r, g, b) < 28) continue; // skip whites, blacks and greys
      count.set("#" + h, (count.get("#" + h) || 0) + 1);
    }
    const colors = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map((e) => e[0]);
    const fonts = new Map();
    for (const h of sheetHrefs.filter((x) => /fonts\.googleapis/i.test(x))) for (const m of h.matchAll(/family=([^&:]+)/gi)) fonts.set(decodeURIComponent(m[1]).replace(/\+/g, " "), 99);
    for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
      const f = m[1].split(",")[0].replace(/&quot;/g, "").trim().replace(/^['"\\]+|['"\\]+$/g, "").trim();
      if (!f || /^(inherit|initial|unset|sans-serif|serif|monospace|system-ui|-apple-system|blinkmacsystemfont|var\()/i.test(f)) continue;
      fonts.set(f, (fonts.get(f) || 0) + 1);
    }
    const fontList = [...fonts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((e) => e[0]);
    const logoTag = [...html.matchAll(/<img[^>]+>/gi)].map((m) => m[0]).find((t) => /logo/i.test(t));
    const logo = logoTag ? abs((logoTag.match(/src=["']([^"']+)["']/i) || [])[1] || "") : "";
    parts.push(`Brand signals: theme colour ${theme || "none"}; most-used colours ${colors.join(", ") || "none found"}; fonts ${fontList.join(", ") || "none found"}${logo ? `; logo image ${logo}` : ""}`);
  }
  if (deep) {
    // Read further: the site's own About / Product / Pricing / Solutions pages
    const base = new URL(res.url || url);
    const seen = new Set([base.pathname.replace(/\/$/, "")]);
    const links = [];
    for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
      let u; try { u = new URL(m[1], base); } catch { continue; }
      const path = u.pathname.replace(/\/$/, "");
      if (u.hostname !== base.hostname || seen.has(path) || !/(about|company|who-we|product|platform|solution|feature|pricing|plans|customer|case-stud|use-case|service|how-it-works)/i.test(path)) continue;
      seen.add(path); links.push(u.toString());
    }
    for (const p of ["/about", "/pricing", "/product"]) { const u = new URL(p, base).toString(); if (!seen.has(p)) { seen.add(p); links.push(u); } }
    const pages = await Promise.all(links.slice(0, 5).map(async (u) => {
      try {
        const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (compatible; LironSoferPortfolio/1.0)", accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(6000) });
        if (!r.ok || !/html/i.test(r.headers.get("content-type") || "")) return "";
        const h = (await r.text()).slice(0, 300000);
        const t = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
        const txt = dec(h.replace(/<(script|style|noscript|svg|template|nav|footer)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 2500);
        return txt.length > 80 ? `--- Page ${r.url}${t ? ` (${dec(t).trim()})` : ""}\n${txt}` : "";
      } catch { return ""; }
    }));
    const more = pages.filter(Boolean);
    if (more.length) parts.push("More pages from the same site:\n" + more.join("\n"));
  }
  return parts.join("\n");
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDueReminders(env));
  },
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    // Live site, plus the staging copy on Cloudflare Pages (any project named lironsofer…)
    if (!ALLOWED_ORIGINS.includes(origin) && !/^https:\/\/([a-z0-9-]+\.)?lironsofer[a-z0-9-]*\.pages\.dev$/.test(origin)) {
      return new Response("Not allowed", { status: 403 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    // Image pass-through so the site can draw a brand's own images into its ads
    if (request.method === "GET" && new URL(request.url).searchParams.has("caps")) {
      return reply(200, { images: !!(env.GEMINI_API_KEY || env.OPENAI_API_KEY), emailFinder: !!env.HUNTER_API_KEY,
        googleClientId: env.GOOGLE_CLIENT_ID || "", gmailSend: env.GMAIL_SEND === "on", models: ["claude", "openai", "gemini"].filter((m) => env[{ claude: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" }[m]]) }, origin);
    }
    // Family trip page: read the shared (encrypted) trip data and progress marks
    if (request.method === "GET" && new URL(request.url).searchParams.has("trip")) {
      const u = new URL(request.url);
      if (!env.TRIP || !env.TRIP_TOKEN) return reply(404, { code: "not_configured", message: "Trip storage isn't connected" }, origin);
      if (!sameText(u.searchParams.get("tok"), env.TRIP_TOKEN)) return reply(403, { code: "bad_token", message: "Not allowed" }, origin);
      const id = tripId(u.searchParams.get("trip"));
      const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors(origin) } });
      const bid = String(u.searchParams.get("blob") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
      if (bid) {
        const enc = await env.TRIP.get("blob:" + id + ":" + bid);
        if (!enc) return reply(404, { code: "not_found", message: "File not found" }, origin);
        return new Response(JSON.stringify({ enc }), { status: 200, headers: { "content-type": "application/json", "cache-control": "private, max-age=31536000, immutable", ...cors(origin) } });
      }
      if (u.searchParams.has("hist")) {
        const rev = u.searchParams.get("hist") === "list" ? 0 : Number(u.searchParams.get("hist"));
        if (rev > 0) { const h = await env.TRIP.get("hist:" + id + ":" + rev, "json"); return h ? json(h) : reply(404, { code: "not_found", message: "Version not found" }, origin); }
        const idx = (await env.TRIP.get("histidx:" + id, "json")) || [];
        const list = [];
        for (const r of idx.slice().reverse()) { const h = await env.TRIP.get("hist:" + id + ":" + r, "json"); if (h) list.push({ rev: h.rev, savedAt: h.savedAt || "" }); }
        return json({ list });
      }
      const [stored, prog, tickets] = await Promise.all([env.TRIP.get("trip:" + id, "json"), env.TRIP.get("prog:" + id, "json"), env.TRIP.get("tickets:" + id, "json")]);
      return json({ rev: stored?.rev || 0, enc: stored?.enc || "", savedAt: stored?.savedAt || "", prog: prog || {}, tickets: tickets?.enc || "",
        editCode: !!env.TRIP_EDIT_CODE, push: !!env.VAPID_PRIVATE });
    }
    if (request.method === "GET") {
      const target = new URL(request.url).searchParams.get("img") || "";
      if (!/^https:\/\//i.test(target)) return reply(400, { code: "invalid_request", message: "Missing image" }, origin);
      let img;
      try { img = await fetch(target, { signal: AbortSignal.timeout(8000), headers: { accept: "image/*" } }); } catch { img = null; }
      const type = img && img.headers.get("content-type") || "";
      const size = Number(img && img.headers.get("content-length") || 0);
      if (!img || !img.ok || !/^image\/(png|jpe?g|webp|gif|avif)/i.test(type) || size > 6_000_000) {
        return reply(404, { code: "not_found", message: "Image not available" }, origin);
      }
      return new Response(img.body, { status: 200, headers: { "content-type": type, "cache-control": "public, max-age=86400", ...cors(origin) } });
    }
    if (request.method !== "POST") {
      return reply(405, { code: "invalid_request", message: "Use POST" }, origin);
    }

    const raw = await request.text();
    const isImage = raw.startsWith('{"image"');
    const isTrip = raw.startsWith('{"trip');
    const bigTrip = raw.startsWith('{"tripBlobPut"') || raw.startsWith('{"tripScan"');
    if (raw.length > (isImage ? 9_000_000 : bigTrip ? 6_000_000 : isTrip ? 400_000 : MAX_BODY_BYTES)) {
      return reply(413, { code: "prompt_too_large", message: "Prompt is too long" }, origin);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (isTrip) {
      if (overLimit(ip, tripHits, 300)) return reply(429, { code: "rate_limited", message: "Too many saves. Try again in a few minutes." }, origin);
      if (raw.startsWith('{"tripScan"') && overLimit(ip, scanHits, 20)) return reply(429, { code: "rate_limited", message: "Too many scans. Try again in a few minutes." }, origin);
      let tb; try { tb = JSON.parse(raw); } catch { return reply(400, { code: "invalid_request", message: "Body must be JSON" }, origin); }
      return tripPost(tb, env, origin, ctx);
    }

    let body;
    try { body = JSON.parse(raw); } catch {
      return reply(400, { code: "invalid_request", message: "Body must be JSON" }, origin);
    }
    if (!body || typeof body !== "object") return reply(400, { code: "invalid_request", message: "Body must be a JSON object" }, origin);

    // Company-name autocomplete (Reachlist Builder): its own, generous limit
    if (typeof body.companySuggest === "string") {
      const q = body.companySuggest.trim().slice(0, 60);
      if (q.length < 2) return reply(200, { companies: [] }, origin);
      if (overLimit(ip, suggestHits, PER_IP_SUGGEST)) return reply(429, { code: "rate_limited", message: "Slow down a little" }, origin);
      return reply(200, { companies: await suggestCompanies(q) }, origin);
    }

    const isPeople = !!(body.findPeople || body.findEmail);
    if (isPeople ? overLimit(ip, peopleHits, PER_IP_PEOPLE) : overLimit(ip)) {
      return reply(429, { code: "rate_limited", message: "Too many requests. Try again in a few minutes." }, origin);
    }

    // Everyone with a known work email at a company (Hunter.io domain search), so the tool can
    // prefer a contact who has an email. Returns { people:[...], generic:[...] }.
    if (body.findPeople && typeof body.findPeople === "object") {
      if (!env.HUNTER_API_KEY) return reply(200, { people: [], generic: [], unavailable: true }, origin);
      const domain = String(body.findPeople.domain || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[\/?#].*$/, "");
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return reply(400, { code: "invalid_request", message: "Need a company domain" }, origin);
      if (peopleCache.has(domain)) return reply(200, peopleCache.get(domain), origin);
      let res, data = {};
      try {
        res = await fetch(`https://api.hunter.io/v2/domain-search?${new URLSearchParams({ domain, limit: "10" })}`, { headers: { "X-API-KEY": env.HUNTER_API_KEY }, signal: AbortSignal.timeout(9000) });
        data = await res.json().catch(() => ({}));
      } catch { return reply(200, { people: [], generic: [], unavailable: true }, origin); }
      if (!res.ok) return reply(200, { people: [], generic: [], unavailable: true, reason: res.status === 429 ? "limit" : "error" }, origin);
      const emails = Array.isArray(data?.data?.emails) ? data.data.emails : [];
      const out = {
        people: emails.filter((e) => e && e.type === "personal" && e.value).map((e) => ({
          name: [e.first_name, e.last_name].filter(Boolean).join(" ").slice(0, 80), title: String(e.position || "").slice(0, 100),
          seniority: e.seniority || "", department: e.department || "", email: e.value, confidence: Number(e.confidence) || 0,
          linkedin: /^https:\/\/([a-z]+\.)?linkedin\.com\/in\//i.test(e.linkedin || "") ? e.linkedin : "", verified: e.verification?.status === "valid",
        })),
        generic: emails.filter((e) => e && e.type === "generic" && e.value).map((e) => e.value).slice(0, 3),
      };
      if (peopleCache.size > 3000) peopleCache.clear();
      peopleCache.set(domain, out);
      return reply(200, out, origin);
    }

    // Find a person's work email (Hunter.io). Only real, found addresses are returned.
    if (body.findEmail && typeof body.findEmail === "object") {
      if (!env.HUNTER_API_KEY) return reply(400, { code: "not_configured", message: "Email finder isn't connected" }, origin);
      const f = body.findEmail;
      const domain = String(f.domain || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
      const first = String(f.first || "").trim().slice(0, 60), last = String(f.last || "").trim().slice(0, 60);
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || !first) return reply(400, { code: "invalid_request", message: "Need a domain and a first name" }, origin);
      const q = new URLSearchParams({ domain, first_name: first, ...(last ? { last_name: last } : {}) });
      const res = await fetch(`https://api.hunter.io/v2/email-finder?${q}`, { headers: { "X-API-KEY": env.HUNTER_API_KEY } });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) return reply(429, { code: "rate_limited", message: "Email finder limit reached" }, origin);
      if (!res.ok) return reply(res.status === 404 ? 200 : 502, res.status === 404 ? { email: "" } : { code: "upstream_error", message: data?.errors?.[0]?.details || "Email finder error" }, origin);
      const d = data.data || {};
      return reply(200, { email: d.email || "", score: Number(d.score) || 0, status: d.verification?.status || "", sources: Array.isArray(d.sources) ? d.sources.length : 0 }, origin);
    }

    // Finished ad image: Nano Banana (Gemini), with OpenAI's image model as backup
    if (body.image && typeof body.image === "object") {
      if (!env.GEMINI_API_KEY && !env.OPENAI_API_KEY) return reply(400, { code: "not_configured", message: "Images aren't connected yet" }, origin);
      if (overLimit(ip, imageHits, PER_IP_IMAGES)) return reply(429, { code: "rate_limited", message: "Image limit reached. Try again in a few minutes." }, origin);
      const prompt = String(body.image.prompt || "").slice(0, 6000);
      if (!prompt.trim()) return reply(400, { code: "invalid_request", message: "Missing prompt" }, origin);
      const ASPECTS = ["1:1", "4:5", "5:4", "9:16", "16:9", "21:9", "8:1", "1:4", "3:4", "4:3", "2:3", "3:2"];
      const aspect = ASPECTS.includes(body.image.aspect) ? body.image.aspect : "1:1";
      const refs = (Array.isArray(body.image.refs) ? body.image.refs : []).slice(0, 2)
        .map((u) => String(u).match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/)).filter(Boolean)
        .map((m) => ({ mime: m[1], data: m[2] }));
      let out = null, lastErr = null;
      if (env.GEMINI_API_KEY) {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1/models/${env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1"}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ parts: [...refs.map((r) => ({ inlineData: { mimeType: r.mime, data: r.data } })), { text: prompt }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: aspect, imageSize: "1K" } },
          }),
        });
        const data = await res.json().catch(() => ({}));
        const part = (data?.candidates?.[0]?.content?.parts || []).find((x) => x.inlineData || x.inline_data);
        const inl = part && (part.inlineData || part.inline_data);
        if (res.ok && inl?.data) out = `data:${inl.mimeType || inl.mime_type || "image/png"};base64,${inl.data}`;
        else lastErr = { status: res.status, message: data?.error?.message || (data?.candidates?.[0]?.finishReason ? "The image model declined this prompt" : "Image error"), refused: res.ok };
      }
      if (!out && env.OPENAI_API_KEY) {
        const [aw, ah] = aspect.split(":").map(Number);
        const size = aw / ah > 1.2 ? "1536x1024" : aw / ah < 0.83 ? "1024x1536" : "1024x1024";
        const res = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
          body: JSON.stringify({ model: env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare", prompt, size, quality: "medium", output_format: "jpeg", n: 1 }),
        });
        const data = await res.json().catch(() => ({}));
        const b64 = data?.data?.[0]?.b64_json;
        if (res.ok && b64) out = `data:image/jpeg;base64,${b64}`;
        else lastErr = { status: res.status, message: data?.error?.message || "Image error", refused: res.status === 400 };
      }
      if (!out) {
        const busy = lastErr && lastErr.status === 429;
        return reply(busy ? 429 : 502, { code: busy ? "rate_limited" : lastErr && lastErr.refused ? "refused" : "upstream_error", message: lastErr ? lastErr.message : "Image error" }, origin);
      }
      return reply(200, { image: out }, origin);
    }

    // Tool-using projects (Ad Performance Copilot) send a full Messages API request
    // and run their own tools in the browser; pass it through with safe limits.
    if (body.raw && typeof body.raw === "object") {
      const r = body.raw;
      const okMsgs = Array.isArray(r.messages) && r.messages.length &&
        r.messages.every((m) => m && (m.role === "user" || m.role === "assistant") && (typeof m.content === "string" || Array.isArray(m.content)));
      if (!okMsgs) return reply(400, { code: "invalid_request", message: "Bad messages" }, origin);
      const tools = (Array.isArray(r.tools) ? r.tools : [])
        .filter((t) => t && !t.type && typeof t.name === "string" && t.input_schema)
        .slice(0, 12);
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: r.model === MODELS.quick ? MODELS.quick : MODELS.default,
          max_tokens: Math.min(Number(r.max_tokens) || 1500, 2000),
          system: typeof r.system === "string" ? r.system.slice(0, 6000) : undefined,
          messages: r.messages,
          ...(tools.length ? { tools } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const busy = res.status === 429 || res.status === 529;
        return reply(busy ? 429 : 502, { error: { message: busy ? "Too many requests right now. Try again in a minute." : (data?.error?.message || "AI service error") } }, origin);
      }
      return reply(200, { content: data.content, stop_reason: data.stop_reason }, origin);
    }

    const messages = Array.isArray(body.messages)
      ? body.messages
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
          .map((m) => ({ role: m.role, content: m.content }))
      : [];
    if (!messages.length || messages[0].role !== "user" || messages[messages.length - 1].role !== "user") {
      return reply(400, { code: "invalid_request", message: "Messages must start and end with a user turn" }, origin);
    }

    // If the page asked about a specific website, read that site directly and add it to the question
    let siteText = "";
    if (typeof body.siteUrl === "string" && body.siteUrl.trim()) {
      siteText = await readSite(body.siteUrl.trim(), !!body.deep, !!body.brand);
      if (siteText) {
        const last = messages[messages.length - 1];
        last.content += `\n\nThe website's own pages, fetched just now (treat this as the main evidence about the business):\n"""\n${siteText.slice(0, MAX_PROMPT_CHARS)}\n"""`;
      }
    }

    const system = body.json
      ? "Your reply will be parsed by a program. Reply with only the requested JSON value: no preamble, no explanation, no code fences."
      : "You are the AI inside a small web tool on a personal portfolio site. Follow the instructions in the user's message exactly.";

    const tools = body.webSearch
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]
      : undefined;

    // Ask Claude. With web search, a long turn can pause; continue it up to 3 times.
    async function ask(force) {
      let convo = messages, data = {}, text = "", searched = 0;
      for (let round = 0; round < 4; round++) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: MODELS[body.tier] || MODELS.default,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: tools ? system + " You can search the web; use it to check facts and cite real pages." : system,
            messages: convo,
            ...(tools ? { tools } : {}),
            ...(force && round === 0 ? { tool_choice: { type: "any" } } : {}),
          }),
        });
        data = await res.json().catch(() => ({}));
        if (!res.ok) return { error: res.status, message: data?.error?.message || "AI service error" };
        const blocks = data.content || [];
        searched += blocks.filter((b) => b.type === "server_tool_use").length;
        if (body.json) {
          // keep only the text after the final search result, where the JSON lives
          const lastTool = blocks.map((b) => b.type).lastIndexOf("web_search_tool_result");
          text = blocks.slice(lastTool + 1).filter((b) => b.type === "text").map((b) => b.text).join("") || text;
        } else {
          text += blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
        }
        if (data.stop_reason !== "pause_turn") break;
        convo = [...convo, { role: "assistant", content: blocks }];
      }
      return { text, searched, truncated: data.stop_reason === "max_tokens" };
    }

    async function claude() {
      if (!env.ANTHROPIC_API_KEY) return { error: 0 };
      let out = await ask(false);
      // A web-search request that came back without searching gets one forced retry
      if (tools && !siteText && !out.error && out.searched === 0) {
        const forced = await ask(true);
        if (!forced.error && forced.text.trim()) out = forced;
      }
      return out;
    }

    async function gemini() {
      if (!env.GEMINI_API_KEY) return { error: 0 };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || "gemini-3.8-flash"}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          ...(body.webSearch ? { tools: [{ google_search: {} }] } : {}),
          generationConfig: { maxOutputTokens: 16000 },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: res.status, message: data?.error?.message || "Gemini error" };
      const cand = data?.candidates?.[0] || {};
      return { text: (cand.content?.parts || []).map((x) => x.text || "").join(""), truncated: cand.finishReason === "MAX_TOKENS",
        searched: (cand.groundingMetadata?.webSearchQueries || []).length };
    }

    async function openai() {
      if (!env.OPENAI_API_KEY) return { error: 0 };
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: env.OPENAI_MODEL || "gpt-5.5",
          instructions: system + (body.webSearch ? " You can search the web; use it to check facts." : ""),
          input: messages,
          max_output_tokens: 16000,
          ...(body.webSearch ? { tools: [{ type: "web_search" }] } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: res.status, message: data?.error?.message || "GPT error" };
      const items = Array.isArray(data.output) ? data.output : [];
      const text = data.output_text || items.filter((o) => o.type === "message")
        .flatMap((o) => o.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join("");
      return { text, truncated: data.status === "incomplete", searched: items.filter((o) => o.type === "web_search_call").length };
    }

    // Route each job to the AI that suits it best; fall back to the next one if it isn't connected or fails
    const CALL = { claude, gemini, openai };
    const task = ROUTES[body.task] ? body.task : (body.webSearch ? "research" : "copy");
    let order = ROUTES[task];
    try { const custom = env.ROUTES ? JSON.parse(env.ROUTES)[task] : null; if (Array.isArray(custom) && custom.length) order = custom; } catch {}
    let out = { error: 0 }, used = "";
    for (const name of order) {
      if (!CALL[name]) continue;
      out = await CALL[name]();
      used = name;
      if (!out.error && String(out.text || "").trim()) break;
      if (out.error === 400 || out.error === 413) break; // the request itself was refused; another model won't fix it
    }
    if (out.error === 0) return reply(400, { code: "not_configured", message: "No AI model is connected" }, origin);
    if (out.error) {
      const busy = out.error === 429 || out.error === 529;
      return reply(busy ? 429 : 502, { code: busy ? "rate_limited" : "upstream_error", message: out.message }, origin);
    }
    return reply(200, { text: out.text, truncated: out.truncated, searched: out.searched, model: used }, origin);
  },
};
