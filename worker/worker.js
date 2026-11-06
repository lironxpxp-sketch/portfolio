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
 *   HUNTER_API_KEY     (Secret, optional)  key from hunter.io: finds work emails in Reachlist
 *   GOOGLE_CLIENT_ID   (Text, optional)    OAuth client ID: "Sign in with Google" in Reachlist
 *   GMAIL_SEND         (Text, optional)    set to "on" to send straight from Gmail (needs Google's app review for the public)
 *   TRIP               (KV binding, optional) shared, editable data for the family trip page (/vietnam-2026/)
 *   TRIP_EDIT_KEY      (Secret, optional)  the code people type on the trip page to save changes
 */

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
async function readSite(input, deep = false) {
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
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response("Not allowed", { status: 403 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    // Image pass-through so the site can draw a brand's own images into its ads
    if (request.method === "GET" && new URL(request.url).searchParams.has("caps")) {
      return reply(200, { images: !!(env.GEMINI_API_KEY || env.OPENAI_API_KEY), emailFinder: !!env.HUNTER_API_KEY,
        googleClientId: env.GOOGLE_CLIENT_ID || "", gmailSend: env.GMAIL_SEND === "on", trip: !!(env.TRIP && env.TRIP_EDIT_KEY), models: ["claude", "openai", "gemini"].filter((m) => env[{ claude: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" }[m]]) }, origin);
    }
    // Family trip page: read the shared trip data
    if (request.method === "GET" && new URL(request.url).searchParams.has("trip")) {
      if (!env.TRIP || !env.TRIP_EDIT_KEY) return reply(404, { code: "not_configured", message: "Trip storage isn't connected" }, origin);
      const id = String(new URL(request.url).searchParams.get("trip") || "").replace(/[^a-z0-9-]/gi, "").slice(0, 40);
      if (!id) return reply(400, { code: "invalid_request", message: "Missing trip id" }, origin);
      const stored = await env.TRIP.get("trip:" + id, "json");
      return new Response(JSON.stringify(stored || { rev: 0, data: null }), {
        status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors(origin) } });
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
    if (raw.length > (isImage ? 9_000_000 : MAX_BODY_BYTES)) {
      return reply(413, { code: "prompt_too_large", message: "Prompt is too long" }, origin);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (overLimit(ip)) {
      return reply(429, { code: "rate_limited", message: "Too many requests. Try again in a few minutes." }, origin);
    }

    let body;
    try { body = JSON.parse(raw); } catch {
      return reply(400, { code: "invalid_request", message: "Body must be JSON" }, origin);
    }

    // Family trip page: save the shared trip data (needs the edit code; refuses stale saves)
    if (body.tripSave && typeof body.tripSave === "object") {
      if (!env.TRIP || !env.TRIP_EDIT_KEY) return reply(400, { code: "not_configured", message: "Trip storage isn't connected" }, origin);
      const t = body.tripSave;
      const id = String(t.id || "").replace(/[^a-z0-9-]/gi, "").slice(0, 40);
      const key = String(t.key || "");
      let same = key.length === env.TRIP_EDIT_KEY.length;
      for (let i = 0; i < env.TRIP_EDIT_KEY.length; i++) if (key.charCodeAt(i) !== env.TRIP_EDIT_KEY.charCodeAt(i)) same = false;
      if (!same) return reply(403, { code: "bad_key", message: "Wrong edit code" }, origin);
      if (!id || !t.data || typeof t.data !== "object" || !Array.isArray(t.data.days)) return reply(400, { code: "invalid_request", message: "Missing trip data" }, origin);
      const current = (await env.TRIP.get("trip:" + id, "json")) || { rev: 0 };
      if (Number(t.rev) !== Number(current.rev || 0)) return reply(409, { code: "conflict", message: "Someone saved a newer version", rev: current.rev }, origin);
      const next = { rev: (current.rev || 0) + 1, data: t.data, savedAt: new Date().toISOString() };
      await env.TRIP.put("trip:" + id, JSON.stringify(next));
      return reply(200, { rev: next.rev }, origin);
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
      siteText = await readSite(body.siteUrl.trim(), !!body.deep);
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
