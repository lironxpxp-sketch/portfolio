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

HEAD = ('<script>try{document.documentElement.dataset.theme="dark"}catch(e){}</script>'
        '<script src="../../assets/claude-shim.js"></script>')

BACK = '''<a href="../../index.html" class="pf-back" aria-label="Back to portfolio">&larr; Portfolio</a>
<style>.pf-back{position:fixed;right:max(12px,env(safe-area-inset-right,0px));bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9999;font:600 13px/1 ui-monospace,Menlo,monospace;color:#0b0d12;background:#c6f432;padding:9px 13px;border-radius:999px;text-decoration:none;box-shadow:0 4px 18px rgba(0,0,0,.4)}.pf-back:hover{filter:brightness(1.08)}</style>
</body>'''

# Small per-project copy fixes for running outside claude.ai
TWEAKS = {
    "pre-call-brief": [
        ("Drafting needs Claude, which isn't available in this view.",
         "AI drafting is switched off right now. Pick a sample meeting on the left to see a finished brief."),
    ],
}


def prepare(raw_path, slug):
    s = open(raw_path, encoding="utf8").read()
    if "claude-shim.js" not in s:
        s = s.replace("<head>", "<head>" + HEAD, 1)
    if "pf-back" not in s:
        i = s.rfind("</body>")
        s = s[:i] + BACK + s[i + len("</body>"):] if i >= 0 else s + BACK
    for old, new in TWEAKS.get(slug, []):
        s = s.replace(old, new)
    out = os.path.join(ROOT, "projects", slug, "index.html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w", encoding="utf8").write(s)
    print("wrote", out)


if __name__ == "__main__":
    prepare(sys.argv[1], sys.argv[2])
