/*
 * AI backend for lironsofer.online — a Cloudflare Worker.
 * The website sends a prompt here; this Worker adds your secret Anthropic
 * API key and asks Claude. The key never reaches visitors' browsers.
 *
 * Settings (Cloudflare dashboard → your Worker → Settings → Variables):
 *   ANTHROPIC_API_KEY  (Secret)  your key from console.anthropic.com
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

const MAX_BODY_BYTES = 60_000;   // largest prompt accepted
const MAX_OUTPUT_TOKENS = 6000;  // longest answer
const PER_IP_LIMIT = 40;         // AI calls per visitor...
const PER_IP_WINDOW_MS = 10 * 60 * 1000; // ...per 10 minutes (best effort)

const hits = new Map();

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

function overLimit(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < PER_IP_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > PER_IP_LIMIT;
}

// Read a website's own page (title, description, headings, visible text) so new
// sites that search engines haven't indexed yet can still be understood.
async function readSite(input) {
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
  return parts.length > 1 ? parts.join("\n") : "";
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
    if (raw.length > MAX_BODY_BYTES) {
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
      siteText = await readSite(body.siteUrl.trim());
      if (siteText) {
        const last = messages[messages.length - 1];
        last.content += `\n\nThe website's own page, fetched just now (treat this as the main evidence about the business):\n"""\n${siteText}\n"""`;
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

    let out = await ask(false);
    // A web-search request that came back without searching gets one forced retry
    if (tools && !siteText && !out.error && out.searched === 0) {
      const forced = await ask(true);
      if (!forced.error && forced.text.trim()) out = forced;
    }
    if (out.error) {
      const busy = out.error === 429 || out.error === 529;
      return reply(busy ? 429 : 502, { code: busy ? "rate_limited" : "upstream_error", message: out.message }, origin);
    }
    return reply(200, { text: out.text, truncated: out.truncated, searched: out.searched }, origin);
  },
};
