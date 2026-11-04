#!/usr/bin/env python3
"""Turn a project's HTML (as published on claude.ai) into a page for lironsofer.online.

Usage: python3 tools/prepare_project.py <raw.html> <slug>
Writes projects/<slug>/index.html, adding:
  - the AI connector (assets/claude-shim.js), loaded before the page's own scripts
  - dark theme by default
  - a "← Portfolio" button back to the homepage
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Bump when assets/claude-shim.js changes, so browsers don't keep an old copy
SHIM_VERSION = "9"

HEAD = ('<script>try{document.documentElement.dataset.theme="dark"}catch(e){}</script>'
        '<script src="../../assets/claude-shim.js?v=' + SHIM_VERSION + '"></script>'
        '<script>if(/(^|\\.)lironsofer\\.online$/.test(location.hostname)){var g=document.createElement("script");g.async=true;g.dataset.goatcounter="https://lironsofer.goatcounter.com/count";g.src="https://gc.zgo.at/count.js";document.head.appendChild(g)}</script>')

BACK = '''<a href="../../index.html" class="pf-back" aria-label="Back to portfolio">&larr; Portfolio</a>
<style>.pf-back{position:fixed;right:max(12px,env(safe-area-inset-right,0px));bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9999;font:600 13px/1 ui-monospace,Menlo,monospace;color:#0b0d12;background:#c6f432;padding:9px 13px;border-radius:999px;text-decoration:none;box-shadow:0 4px 18px rgba(0,0,0,.4)}.pf-back:hover{filter:brightness(1.08)}</style>
</body>'''

# Small per-project copy fixes for running outside claude.ai
TWEAKS = {
    # Market Research Agent: master copy lives in sources/market-research.html (site changes already built in)
    # Ad Performance Copilot: visitors without their own API key use the site's backend
    "ad-copilot": [
        ('let KEY="";try{KEY=localStorage.getItem("adcopilot.key")||""}catch(e){}',
         'let KEY="";try{KEY=localStorage.getItem("adcopilot.key")||""}catch(e){}\nconst PROXY=window.__aiEndpoint||"";if(!KEY&&PROXY)KEY="__site__";'),
        ('async function callClaude(messages){const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",',
         'async function callClaude(messages){if(KEY==="__site__"){const r=await fetch(PROXY,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({raw:{model:SET.model,max_tokens:1500,system:SYS(),tools:TOOLS,messages}})});let j=null;try{j=await r.json()}catch(e){}if(!r.ok)throw new Error(j?.error?.message||j?.message||`Request failed (HTTP ${r.status})`);return j}\n  const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",'),
        ('$("sKey").value=KEY;', '$("sKey").value=KEY==="__site__"?"":KEY;'),
        ('KEY=$("sKey").value.trim();', 'KEY=$("sKey").value.trim()||(PROXY?"__site__":"");'),
        ('KEY?localStorage.setItem("adcopilot.key",KEY):localStorage.removeItem("adcopilot.key")',
         'KEY&&KEY!=="__site__"?localStorage.setItem("adcopilot.key",KEY):localStorage.removeItem("adcopilot.key")'),
    ],
    "pre-call-brief": [
        ("Drafting needs Claude, which isn't available in this view.",
         "AI drafting is switched off right now. Pick a sample meeting on the left to see a finished brief."),
    ],
}


def prepare(raw_path, slug):
    s = open(raw_path, encoding="utf8").read()
    if "claude-shim.js" not in s:
        s = s.replace("<head>", "<head>" + HEAD, 1)
    import re
    s = re.sub(r'claude-shim\.js(\?v=[^"]*)?"', 'claude-shim.js?v=' + SHIM_VERSION + '"', s)
    if 'class="pf-back"' not in s:
        i = s.rfind("</body>")
        s = s[:i] + BACK + s[i + len("</body>"):] if i >= 0 else s + BACK
    for old, new in TWEAKS.get(slug, []):
        if old not in s:
            print(f"  note: tweak not applied for {slug}: {old[:60]!r}")
        s = s.replace(old, new)
    out = os.path.join(ROOT, "projects", slug, "index.html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w", encoding="utf8").write(s)
    print("wrote", out)


if __name__ == "__main__":
    prepare(sys.argv[1], sys.argv[2])
