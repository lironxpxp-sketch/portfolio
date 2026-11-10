#!/usr/bin/env python3
"""Build the private family trip page (secret link, encrypted).

Usage:
  python3 tools/build_trip.py <trip.html> <folder> [link-or-key]

<trip.html>  the trip app as published on claude.ai (keep it OUT of this public repo)
<folder>     the random folder under t/, e.g. t/k3x9.../
link-or-key  the existing secret link (or just the part after #). Leave it out the
             first time and a new key is made; reuse it later so the link stays the same.

The trip data and app code are encrypted (AES-GCM) with a key that exists only in the
link, after the '#'. Browsers never send that part to any server, so the files in this
repo, and the Worker's storage, hold nothing readable. Prints the link and the
TRIP_TOKEN value for the Cloudflare Worker.
"""
import base64, hashlib, json, os, re, secrets, sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHIM_VERSION = "9"  # keep in step with tools/prepare_project.py
SITE = "https://lironsofer.online"

def b64u(b): return base64.urlsafe_b64encode(b).decode().rstrip("=")
def unb64u(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

src_path, folder = sys.argv[1], sys.argv[2].strip("/")
given = sys.argv[3] if len(sys.argv) > 3 else ""
key = unb64u(given.split("#", 1)[-1]) if given else secrets.token_bytes(32)
assert len(key) == 32, "the key must be 32 bytes"

src = open(src_path, encoding="utf8").read()
grab = lambda pat: re.search(pat, src, re.S).group(1)
data = grab(r'<script id="trip-data" type="application/json">\s*(.*?)\s*</script>').replace("<\\/", "</")
json.loads(data)
app = grab(r'<script id="app-script">(.*?)</script>')
css = grab(r'<style id="app-style">(.*?)</style>')
fonts = re.search(r'<link rel="stylesheet" href="https://fonts\.googleapis\.com[^>]*>', src).group(0)

iv = secrets.token_bytes(12)
bundle = json.dumps({"data": data, "app": app}, ensure_ascii=False).encode()
sealed = base64.b64encode(iv + AESGCM(key).encrypt(iv, bundle, None)).decode()

page = f'''<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0d6857">
<link rel="apple-touch-icon" href="icon-192.png">
<link rel="manifest" href="manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="הטיול">
<title>הטיול</title>
<meta name="claude:viewport-fit-sides" content="cover">
{fonts}
<style>:root{{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0}}img{{max-width:100%}}[hidden]{{display:none!important}}
.locked{{min-height:80vh;display:grid;place-items:center;text-align:center;padding:24px max(16px,env(safe-area-inset-right,0px)) 24px max(16px,env(safe-area-inset-left,0px));font:18px/1.5 'Assistant',system-ui,sans-serif;color:var(--ink)}}
.locked h1{{font:400 26px/1.2 'Suez One',Georgia,serif;margin:0 0 8px}}</style>
<style id="app-style">{css}</style>
<script src="../../assets/claude-shim.js?v={SHIM_VERSION}"></script>
</head>
<body>
<div id="app"></div>
<div class="locked" id="locked" hidden><div style="max-width:420px"><h1>הקישור לא שלם</h1><p>פתחו את הקישור המלא שקיבלתם, כולל כל מה שאחרי הסימן #.</p><p style="font-size:15px;opacity:.8">פתחתם מאייקון במסך הבית? הדביקו כאן את הקישור המלא פעם אחת:</p><form id="keyform" style="display:flex;gap:8px"><input id="keyinput" type="url" autocomplete="off" placeholder="https://lironsofer.online/t/…" aria-label="הקישור המלא" style="flex:1;min-width:0;font:inherit;font-size:16px;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.25);color:inherit;direction:ltr"><button style="font:inherit;font-weight:700;border:0;border-radius:12px;padding:10px 16px;background:#FFC24B;color:#1A1405">פתיחה</button></form></div></div>
<script id="trip-sealed" type="application/octet-stream">{sealed}</script>
<script>
(function(){{
  function bytes(s){{s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;}}
  function hex(buf){{return Array.prototype.map.call(new Uint8Array(buf),function(x){{return ('0'+x.toString(16)).slice(-2);}}).join('');}}
  function locked(){{
    document.getElementById('locked').hidden=false;
    document.getElementById('keyform').addEventListener('submit',function(e){{
      e.preventDefault();
      var v=(document.getElementById('keyinput').value||'').trim(), k2=v.indexOf('#')>=0?v.split('#').pop():v;
      if(!k2) return;
      try{{ localStorage.setItem('vt-key',k2); }}catch(_){{}}
      location.replace(location.pathname+'#'+k2); location.reload();
    }});
  }}
  var fromLink=(location.hash||'').slice(1), k=fromLink;
  try{{ if(k) localStorage.setItem('vt-key',k); else k=localStorage.getItem('vt-key')||''; }}catch(e){{}}
  if(!k||!window.crypto||!crypto.subtle) return locked();
  var raw; try{{ raw=bytes(k); }}catch(e){{ return locked(); }}
  crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']).then(function(key){{
    var b=bytes(document.getElementById('trip-sealed').textContent.trim());
    return Promise.all([crypto.subtle.decrypt({{name:'AES-GCM',iv:b.slice(0,12)}},key,b.slice(12)),crypto.subtle.digest('SHA-256',raw)]).then(function(r){{
      var bundle=JSON.parse(new TextDecoder().decode(r[0]));
      window.__trip={{key:key,tok:hex(r[1])}};
      if(!fromLink){{ try{{ history.replaceState(null,'',location.pathname+'#'+k); }}catch(e){{}} }}
      var d=document.createElement('script'); d.type='application/json'; d.id='trip-data'; d.textContent=bundle.data; document.body.appendChild(d);
      var s=document.createElement('script'); s.id='app-script'; s.textContent=bundle.app; document.body.appendChild(s);
    }});
  }}).catch(locked);
}})();
</script>
</body>
</html>
'''
out_dir = os.path.join(ROOT, folder)
os.makedirs(out_dir, exist_ok=True)
open(os.path.join(out_dir, "index.html"), "w", encoding="utf8").write(page)

# Nothing readable about the trip may reach the public repo
for needle in ("VN247", "May De Ville", "Dusit", "Orchids", "Heritage", "VN169", "Etihad", "Vietnam247", "16.11"):
    assert needle not in page, f"plaintext leak: {needle}"

print("wrote", os.path.join(folder, "index.html"))
print("LINK      ", f"{SITE}/{folder}/#{b64u(key)}")
print("TRIP_TOKEN", hashlib.sha256(key).hexdigest())
