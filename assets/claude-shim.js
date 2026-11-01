/*
 * Connects the projects on lironsofer.online to your own AI backend.
 * The projects were built as Claude artifacts and ask for features with
 * `claude.use("sample")` / `claude.use("downloads")`. Off claude.ai those
 * don't exist, so this file provides them:
 *   sample    -> your Cloudflare Worker, which calls the Anthropic API
 *               (pass {webSearch:true} to let it search the live web)
 *   downloads -> a normal browser download
 *   anything else -> null (the project falls back to its built-in demo data)
 *
 * Set AI_ENDPOINT to your Worker's URL after you deploy it.
 * Leave it empty and the projects run in demo/template mode.
 */
(function () {
  var AI_ENDPOINT = "https://liron-ai.lironxpxp.workers.dev"; // e.g. "https://liron-ai.<your-subdomain>.workers.dev"

  if (window.claude && window.claude.use) return; // running inside Claude: use the real thing

  function fail(code, message, text) {
    var e = { code: code, message: message || code };
    if (text) e.text = text;
    return e;
  }

  function parseJSON(text) {
    var t = String(text || "").trim();
    try { return JSON.parse(t); } catch (e) {}
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) { try { return JSON.parse(fence[1].trim()); } catch (e) {} }
    var a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
    throw fail("invalid_json", "Reply held no JSON value", t);
  }

  async function call(input, opts, wantJSON) {
    opts = opts || {};
    var messages = typeof input === "string"
      ? [{ role: "user", content: input }]
      : (Array.isArray(input) ? input : null);
    if (!messages || !messages.length) throw fail("invalid_request", "Input must be a string or a list of turns");
    if (opts.signal && opts.signal.aborted) throw fail("cancelled");
    var res;
    try {
      res = await fetch(AI_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: messages, json: !!wantJSON, tier: opts.modelTier || "default", webSearch: !!opts.webSearch }),
        signal: opts.signal
      });
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw fail("cancelled");
      throw fail("upstream_error", "Could not reach the AI service");
    }
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var code = res.status === 429 ? "rate_limited" : res.status === 413 ? "prompt_too_large" : (data.code || "upstream_error");
      throw fail(code, data.message || ("HTTP " + res.status));
    }
    var text = String(data.text || "");
    if (!text.trim()) throw fail("empty_completion", "No text returned");
    if (typeof opts.onText === "function") { try { opts.onText({ text: text, delta: text }); } catch (e) { console.error(e); } }
    if (wantJSON) {
      if (data.truncated) throw fail("invalid_json", "Reply was cut short", text);
      return parseJSON(text);
    }
    return { text: text, truncated: !!data.truncated, modelTierApplied: opts.modelTier || "default" };
  }

  var sample = function (input, opts) { return call(input, opts, false); };
  sample.json = function (input, opts) { return call(input, opts, true); };
  sample.limits = function () { return Promise.resolve({ maxPromptBytes: 60000 }); };

  var downloads = {
    save: function (o) {
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data], { type: "text/plain;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = o.filename || "download";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      return Promise.resolve({ saved: true });
    }
  };

  window.__aiWeb = !!AI_ENDPOINT; // pages can check whether live web search is available
  window.claude = {
    use: function (name) {
      if (name === "sample") return Promise.resolve(AI_ENDPOINT ? sample : null);
      if (name === "downloads") return Promise.resolve(downloads);
      return Promise.resolve(null);
    }
  };
})();
