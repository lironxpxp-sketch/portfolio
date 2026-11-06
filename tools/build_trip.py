#!/usr/bin/env python3
"""Build the family trip page (unlisted) from its master copy.

Usage: python3 tools/build_trip.py
Reads sources/vietnam-trip.html (the same file published as the Claude artifact)
and writes vietnam-2026/index.html with a real <head>: no search indexing,
home-screen icon, the AI connector, and the offline helper (sw.js).
"""
import os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHIM_VERSION = "9"  # keep in step with tools/prepare_project.py

src = open(os.path.join(ROOT, "sources", "vietnam-trip.html"), encoding="utf8").read()
head_bits = []
for pat in (r"<title>.*?</title>\s*", r'<meta name="claude:viewport-fit-sides"[^>]*>\s*', r'<link rel="stylesheet" href="https://fonts\.googleapis\.com[^>]*>\s*'):
    m = re.search(pat, src, re.S)
    if m:
        head_bits.append(m.group(0).strip())
        src = src.replace(m.group(0), "", 1)

page = ('<!doctype html>\n<html lang="he" dir="rtl">\n<head>\n'
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        '<meta name="robots" content="noindex,nofollow">\n'
        '<meta name="theme-color" content="#0d6857">\n'
        '<link rel="manifest" href="manifest.webmanifest">\n'
        '<link rel="apple-touch-icon" href="icon-192.png">\n'
        '<meta name="apple-mobile-web-app-capable" content="yes">\n'
        '<meta name="mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-title" content="וייטנאם">\n'
        + "\n".join(head_bits) + "\n"
        '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n'
        f'<script src="../assets/claude-shim.js?v={SHIM_VERSION}"></script>\n'
        '</head>\n<body>\n' + src.strip() + '\n</body>\n</html>\n')
out = os.path.join(ROOT, "vietnam-2026", "index.html")
open(out, "w", encoding="utf8").write(page)
print("wrote", out)
