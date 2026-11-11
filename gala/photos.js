// Shared storage for Gala's birthday day.
// With the private key (in the link after #, or remembered on this phone) photos and reveals are
// encrypted on the phone and kept on the site's Worker, so both phones see the same album.
// Without the key everything stays on this phone only.
window.GalaPhotos = (() => {
  const API = "https://liron-ai.lironxpxp.workers.dev", TRIP = "gala-bday-2026";
  const b64u = buf => { let s = ""; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const unb64u = s => { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join("");
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  // ---- the private key: from the link, or remembered from an earlier visit ----
  const fromHash = (location.hash.slice(1).split("&").find(p => /^[A-Za-z0-9_-]{43}$/.test(p))) || "";
  const keyText = fromHash || store.get("gala-key") || store.get("vt-key") || "";
  if (fromHash) store.set("gala-key", fromHash);
  let cryptoP = null;
  function keys() {
    if (!cryptoP) cryptoP = (async () => {
      const raw = unb64u(keyText);
      const [key, digest] = await Promise.all([crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]), crypto.subtle.digest("SHA-256", raw)]);
      return { key, tok: hex(digest) };
    })();
    return cryptoP;
  }
  // carry the key along on links between the birthday pages
  function carry() { if (!keyText) return; document.querySelectorAll('a[href^="/gala/"]').forEach(a => { if (!a.hash) a.href = a.getAttribute("href") + "#" + keyText; }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", carry); else carry();
  new MutationObserver(carry).observe(document.documentElement, { childList: true, subtree: true });

  // ---- local fallback (IndexedDB) ----
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open("gala-photos", 1);
      r.onupgradeneeded = () => { const s = r.result.createObjectStore("photos", { keyPath: "id", autoIncrement: true }); s.createIndex("stop", "stop"); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(d => new Promise((res, rej) => {
      const t = d.transaction("photos", mode), out = fn(t.objectStore("photos"));
      t.oncomplete = () => res(out && "result" in out ? out.result : undefined); t.onerror = () => rej(t.error);
    }));
  }
  const localShown = () => { try { return JSON.parse(store.get("gala-revealed") || "{}"); } catch (e) { return {}; } };

  async function shrink(file, max = 1800) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return await new Promise(r => c.toBlob(b => r(b || file), "image/jpeg", 0.85));
    } catch (e) { return file; } finally { URL.revokeObjectURL(url); }
  }

  // ---- cloud ----
  async function post(op, body) {
    const { tok } = await keys();
    const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ [op]: { tok, id: TRIP, ...body } }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || "Couldn't save");
    return j;
  }
  async function putBlob(blob) {
    const { key } = await keys();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, await blob.arrayBuffer()));
    const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
    return (await post("tripBlobPut", { enc: b64u(all) })).blob;
  }
  const blobCache = new Map();
  async function getBlob(bid) {
    if (blobCache.has(bid)) return blobCache.get(bid);
    const p = (async () => {
      const { key, tok } = await keys();
      const r = await fetch(`${API}/?trip=${TRIP}&tok=${tok}&blob=${bid}`);
      if (!r.ok) throw new Error("missing");
      const b = unb64u((await r.json()).enc);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, key, b.slice(12));
      return new Blob([plain], { type: "image/jpeg" });
    })();
    blobCache.set(bid, p); p.catch(() => blobCache.delete(bid));
    return p;
  }
  async function readProg() {
    const { tok } = await keys();
    const r = await fetch(`${API}/?trip=${TRIP}&tok=${tok}&t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error("Couldn't load");
    return (await r.json()).prog || {};
  }

  // move photos and reveals saved on this phone (before syncing existed) into the shared album
  let migrated = null;
  function migrate() {
    if (!migrated) migrated = (async () => {
      const local = await tx("readonly", s => s.getAll()).catch(() => []);
      const set = {};
      for (const p of local || []) { try { const bid = await putBlob(p.blob); set[`A:g:${p.stop}:${bid}`] = Math.round(p.at || Date.now()).toString(36); } catch (e) { return; } }
      Object.keys(localShown()).forEach(k => set[`K:g:rev:${k}`] = "1");
      if (Object.keys(set).length) await post("tripProg", { set });
      for (const p of local || []) await tx("readwrite", s => s.delete(p.id)).catch(() => {});
    })().catch(() => { migrated = null; });
    return migrated;
  }

  const shared = !!keyText && !!(window.crypto && crypto.subtle);
  return {
    shared,
    // {photos:[{id, stop, at, blob}], shown:{stopKey:1}}
    async load() {
      if (!shared) {
        const photos = ((await tx("readonly", s => s.getAll()).catch(() => [])) || []).sort((x, y) => x.at - y.at);
        return { photos, shown: localShown() };
      }
      await migrate();
      const prog = await readProg(), shown = { ...localShown() }, list = [];
      for (const [k, v] of Object.entries(prog)) {
        if (v === null) continue;
        let m = k.match(/^A:g:(\d+):([A-Za-z0-9_-]+)$/);
        if (m) list.push({ id: k, stop: +m[1], bid: m[2], at: parseInt(v, 36) || 0 });
        m = k.match(/^K:g:rev:(\d+)$/);
        if (m) shown[m[1]] = 1;
      }
      list.sort((x, y) => x.at - y.at);
      const photos = [];
      await Promise.all(list.map(async p => { try { p.blob = await getBlob(p.bid); photos.push(p); } catch (e) {} }));
      photos.sort((x, y) => x.at - y.at);
      return { photos, shown };
    },
    async add(stop, files) {
      if (!shared) { for (const f of files) { const blob = await shrink(f); await tx("readwrite", s => s.add({ stop, at: Date.now(), blob })); } return; }
      const set = {};
      for (const f of files) { const blob = await shrink(f); const bid = await putBlob(blob); blobCache.set(bid, Promise.resolve(blob)); set[`A:g:${stop}:${bid}`] = Date.now().toString(36); }
      await post("tripProg", { set });
    },
    async remove(id) {
      if (!shared) return tx("readwrite", s => s.delete(id));
      await post("tripProg", { set: { [id]: null } });
    },
    async reveal(stopKey) {
      const s = localShown(); s[stopKey] = 1; store.set("gala-revealed", JSON.stringify(s));
      if (shared) await post("tripProg", { set: { [`K:g:rev:${stopKey}`]: "1" } }).catch(() => {});
    }
  };
})();
