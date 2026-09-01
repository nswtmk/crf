'use strict';

/* =========================================================================
   store.js — 記録の保存先 (IndexedDB)
   写真も含めてすべて端末の中だけに置く。どこにも送信しない。
   ========================================================================= */

(function (global) {

  const DB_NAME = 'trailmap';
  const DB_VER = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('visits')) {
          const s = db.createObjectStore('visits', { keyPath: 'id' });
          s.createIndex('ts', 'ts');
        }
        if (!db.objectStoreNames.contains('photos')) {
          db.createObjectStore('photos', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      try { out = fn(s); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const uid = () => 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /* ---------- 訪問記録 ---------- */

  const putVisit   = v  => tx('visits', 'readwrite', s => s.put(v)).then(() => v);
  const getVisit   = id => tx('visits', 'readonly',  s => s.get(id));
  const allVisits  = () => tx('visits', 'readonly',  s => s.getAll())
                             .then(list => (list || []).sort((a, b) => b.ts - a.ts));
  const delVisit   = id => tx('visits', 'readwrite', s => s.delete(id));

  /* ---------- 写真 ---------- */

  const putPhoto = (id, blob) => tx('photos', 'readwrite', s => s.put({ id, blob }));
  const getPhoto = id => tx('photos', 'readonly', s => s.get(id));
  const delPhoto = id => tx('photos', 'readwrite', s => s.delete(id));

  function clearAll() {
    return Promise.all([
      tx('visits', 'readwrite', s => s.clear()),
      tx('photos', 'readwrite', s => s.clear()),
    ]);
  }

  /* ---------- 書き出し / 読み込み ----------
     端末のデータが消えると記録も消えるので、持ち出せる形を必ず用意する。
     -------------------------------------------------------------------- */

  function blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(url) {
    const [head, b64] = String(url).split(',');
    const mime = (head.match(/:(.*?);/) || [, 'image/jpeg'])[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  async function exportAll(includePhotos) {
    const visits = await allVisits();
    const out = { format: 'trailmap', version: 1, exportedAt: Date.now(), visits, photos: {} };
    if (includePhotos) {
      for (const v of visits) {
        for (const pid of (v.photos || [])) {
          const rec = await getPhoto(pid);
          if (rec && rec.blob) out.photos[pid] = await blobToDataURL(rec.blob);
        }
      }
    } else {
      // 写真を含めない場合は参照も落として、読み込み時に矛盾しないようにする
      out.visits = visits.map(v => Object.assign({}, v, { photos: [] }));
    }
    return out;
  }

  /**
   * 読み込む。mode='merge' は既存に足す (同じ id は上書き)、'replace' は入れ替え。
   * 返り値は取り込んだ件数。
   */
  async function importAll(data, mode) {
    if (!data || data.format !== 'trailmap' || !Array.isArray(data.visits)) {
      throw new Error('この形式のファイルは読み込めません');
    }
    if (mode === 'replace') await clearAll();

    const photos = data.photos || {};
    let n = 0;
    for (const v of data.visits) {
      if (typeof v.lat !== 'number' || typeof v.lng !== 'number') continue;
      const kept = [];
      for (const pid of (v.photos || [])) {
        if (photos[pid]) {
          try { await putPhoto(pid, dataURLToBlob(photos[pid])); kept.push(pid); }
          catch (e) { /* 壊れた写真は飛ばして記録本体は残す */ }
        }
      }
      await putVisit({
        id: v.id || uid(),
        lat: v.lat, lng: v.lng,
        ts: typeof v.ts === 'number' ? v.ts : Date.now(),
        title: String(v.title || ''),
        comment: String(v.comment || ''),
        photos: kept,
      });
      n++;
    }
    return n;
  }

  /** おおよその使用量。ブラウザが対応していれば返す。 */
  async function usage() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        return { used: e.usage || 0, quota: e.quota || 0 };
      }
    } catch (e) { /* 取れなくても支障はない */ }
    return null;
  }

  global.Store = {
    uid, putVisit, getVisit, allVisits, delVisit,
    putPhoto, getPhoto, delPhoto, clearAll,
    exportAll, importAll, usage, blobToDataURL, dataURLToBlob,
  };

})(typeof window !== 'undefined' ? window : globalThis);
