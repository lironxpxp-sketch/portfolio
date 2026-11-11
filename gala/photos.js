// Photo storage for Gala's birthday day. Photos live on this phone only (IndexedDB), resized to save space.
window.GalaPhotos = (() => {
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open("gala-photos", 1);
      r.onupgradeneeded = () => { const s = r.result.createObjectStore("photos", { keyPath: "id", autoIncrement: true }); s.createIndex("stop", "stop"); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(d => new Promise((res, rej) => {
      const t = d.transaction("photos", mode), s = t.objectStore("photos");
      const out = fn(s);
      t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
    }));
  }
  async function shrink(file, max = 1800) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return await new Promise(r => c.toBlob(b => r(b || file), "image/jpeg", 0.86));
    } catch (e) { return file; } finally { URL.revokeObjectURL(url); }
  }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
  return {
    async add(stop, files) {
      for (const f of files) {
        const blob = await shrink(f);
        await tx("readwrite", s => s.add({ stop, at: Date.now(), blob }));
      }
    },
    all() { return tx("readonly", s => s.getAll()).then(a => (a || []).sort((x, y) => x.stop - y.stop || x.at - y.at)); },
    remove(id) { return tx("readwrite", s => s.delete(id)); }
  };
})();
