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
const PER_IP_LIMIT = 15;         // calls per visitor...
const PER_IP_WINDOW_MS = 10 * 60 * 1000; // ...per 10 minutes (best effort)

const hits = new Map();

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response("Not allowed", { status: 403 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
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

    const messages = Array.isArray(body.messages)
      ? body.messages
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
          .map((m) => ({ role: m.role, content: m.content }))
      : [];
    if (!messages.length || messages[0].role !== "user" || messages[messages.length - 1].role !== "user") {
      return reply(400, { code: "invalid_request", message: "Messages must start and end with a user turn" }, origin);
    }

    const system = body.json
      ? "Your reply will be parsed by a program. Reply with only the requested JSON value: no preamble, no explanation, no code fences."
      : "You are the AI inside a small web tool on a personal portfolio site. Follow the instructions in the user's message exactly.";

    const tools = body.webSearch
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]
      : undefined;

    // Ask Claude. With web search, a long turn can pause; continue it up to 3 times.
    let convo = messages, data = {}, text = "";
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
        }),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const busy = res.status === 429 || res.status === 529;
        return reply(busy ? 429 : 502, { code: busy ? "rate_limited" : "upstream_error", message: data?.error?.message || "AI service error" }, origin);
      }
      const blocks = data.content || [];
      if (body.json) {
        // keep only the last text block group after the final tool result, where the JSON lives
        const lastTool = blocks.map((b) => b.type).lastIndexOf("web_search_tool_result");
        text = blocks.slice(lastTool + 1).filter((b) => b.type === "text").map((b) => b.text).join("") || text;
      } else {
        text += blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      }
      if (data.stop_reason !== "pause_turn") break;
      convo = [...convo, { role: "assistant", content: blocks }];
    }
    return reply(200, { text, truncated: data.stop_reason === "max_tokens" }, origin);
  },
};
